// FILE: hakmun-api/routes/teachers.js
// PURPOSE: Teacher-centric endpoints — all-students roster, student notes.

const express = require("express");
const { requireSession, requireRole } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { signImageUrl } = require("../util/s3");

const router = express.Router();

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

// ===========================================================================
// GET /v1/teachers/students — all students across all teacher's classes
// ===========================================================================

router.get(
  "/v1/teachers/students",
  requireSession,
  requireRole("teacher", "approver", "admin"),
  async (req, res) => {
    try {
      const teacherId = getUserId(req);
      if (!teacherId)
        return res.status(401).json({ ok: false, error: "NO_SESSION" });

      // 1. Find all classes this teacher owns
      // 2. Find all student members (deduplicated)
      // 3. Join profile data, privacy flags
      // 4. Attach enrolled_classes per student
      // 5. Activity stats per student

      const [studentsR, enrollmentsR, activityR] = await Promise.all([
        // Deduplicated student list with profile data
        withTimeout(
          pool.query(
            `SELECT DISTINCT ON (u.user_id)
                    u.user_id,
                    u.display_name,
                    uh.handle AS primary_handle,
                    u.profile_photo_object_key,
                    u.share_progress_default,
                    u.share_city,
                    u.share_country,
                    u.location_city,
                    u.location_country,
                    u.allow_teacher_adjust_default,
                    u.primary_language,
                    u.cefr_current,
                    u.cefr_target
               FROM class_members cm
               JOIN classes c ON c.class_id = cm.class_id AND c.teacher_id = $1::uuid
               JOIN users u ON u.user_id = cm.user_id
               LEFT JOIN user_handles uh
                 ON uh.user_id = u.user_id AND uh.kind = 'primary'
              WHERE cm.role = 'student'
              ORDER BY u.user_id`,
            [teacherId]
          ),
          10000,
          "db-teacher-all-students"
        ),

        // All enrollments for students in teacher's classes (for enrolled_classes array)
        withTimeout(
          pool.query(
            `SELECT cm.user_id, c.class_id, c.name AS class_name,
                    CASE WHEN c.is_active THEN 'active' ELSE 'archived' END AS status,
                    cm.joined_at
               FROM class_members cm
               JOIN classes c ON c.class_id = cm.class_id AND c.teacher_id = $1::uuid
              WHERE cm.role = 'student'
              ORDER BY cm.joined_at ASC`,
            [teacherId]
          ),
          10000,
          "db-teacher-student-enrollments"
        ),

        // Activity stats for all students in teacher's classes
        withTimeout(
          pool.query(
            `SELECT pe.user_id,
                    MAX(pe.ts) AS last_practice_at,
                    COUNT(*) FILTER (WHERE pe.ts >= NOW() - INTERVAL '7 days')::int AS practice_count_7d,
                    COUNT(*) FILTER (WHERE pe.ts >= NOW() - INTERVAL '30 days')::int AS practice_count_30d
               FROM practice_events pe
              WHERE pe.user_id IN (
                SELECT DISTINCT cm.user_id
                  FROM class_members cm
                  JOIN classes c ON c.class_id = cm.class_id AND c.teacher_id = $1::uuid
                 WHERE cm.role = 'student'
              )
              GROUP BY pe.user_id`,
            [teacherId]
          ),
          15000,
          "db-teacher-student-activity"
        ),
      ]);

      // Build lookup maps
      const enrollmentMap = {};
      for (const row of enrollmentsR.rows) {
        if (!enrollmentMap[row.user_id]) enrollmentMap[row.user_id] = [];
        enrollmentMap[row.user_id].push({
          class_id: row.class_id,
          class_name: row.class_name,
          status: row.status,
          joined_at: row.joined_at,
        });
      }

      const activityMap = {};
      for (const row of activityR.rows) {
        activityMap[row.user_id] = row;
      }

      // Assemble response with privacy filtering
      const students = await Promise.all(
        studentsR.rows.map(async (s) => {
          const profilePhotoUrl = await signImageUrl(s.profile_photo_object_key);
          const shareProgress = Boolean(s.share_progress_default);
          const activity = activityMap[s.user_id];

          const student = {
            user_id: s.user_id,
            display_name: s.display_name,
            primary_handle: s.primary_handle,
            profile_photo_url: profilePhotoUrl,
            share_progress_default: s.share_progress_default,
            enrolled_classes: enrollmentMap[s.user_id] || [],
          };

          // Location — gated by share flags
          if (s.share_city) student.location_city = s.location_city;
          if (s.share_country) student.location_country = s.location_country;

          // Teacher-adjust fields
          student.allow_teacher_adjust_default = s.allow_teacher_adjust_default;
          student.primary_language = s.primary_language || "en";

          // Learning level — gated by allow_teacher_adjust_default
          if (Boolean(s.allow_teacher_adjust_default)) {
            student.cefr_current = s.cefr_current || null;
            student.cefr_target = s.cefr_target || null;
          }

          // Activity stats — only if student shares progress
          if (shareProgress && activity) {
            student.last_practice_at = activity.last_practice_at;
            student.practice_count_7d = activity.practice_count_7d;
            student.practice_count_30d = activity.practice_count_30d;
          } else {
            student.last_practice_at = null;
            student.practice_count_7d = null;
            student.practice_count_30d = null;
          }

          return student;
        })
      );

      return res.json({ ok: true, students });
    } catch (err) {
      logger.error("[teachers] list students failed", {
        err: String(err?.message || err),
      });
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

// ===========================================================================
// TEACHER NOTES — global per student per teacher
// ===========================================================================

// Helper: verify teacher has a relationship with the student (shares at least one class)
async function verifyTeacherStudentRelationship(teacherId, studentId) {
  const r = await withTimeout(
    pool.query(
      `SELECT 1
         FROM class_members cm
         JOIN classes c ON c.class_id = cm.class_id AND c.teacher_id = $1::uuid
        WHERE cm.user_id = $2::uuid AND cm.role = 'student'
        LIMIT 1`,
      [teacherId, studentId]
    ),
    8000,
    "db-verify-teacher-student-rel"
  );
  return r.rows.length > 0;
}

// GET /v1/teachers/students/:studentId/notes
router.get(
  "/v1/teachers/students/:studentId/notes",
  requireSession,
  requireRole("teacher", "approver", "admin"),
  async (req, res) => {
    try {
      const teacherId = getUserId(req);
      if (!teacherId)
        return res.status(401).json({ ok: false, error: "NO_SESSION" });

      const { studentId } = req.params;

      // Verify relationship
      const hasRelationship = await verifyTeacherStudentRelationship(
        teacherId,
        studentId
      );
      if (!hasRelationship) {
        return res.status(403).json({ ok: false, error: "NO_RELATIONSHIP" });
      }

      const r = await withTimeout(
        pool.query(
          `SELECT note_text, updated_at
             FROM teacher_student_notes
            WHERE student_user_id = $1::uuid AND teacher_user_id = $2::uuid`,
          [studentId, teacherId]
        ),
        8000,
        "db-get-teacher-notes"
      );

      if (r.rows.length === 0) {
        return res.json({ ok: true, note_text: "", updated_at: null });
      }

      return res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      logger.error("[teachers] get notes failed", {
        err: String(err?.message || err),
      });
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

// PUT /v1/teachers/students/:studentId/notes — upsert
router.put(
  "/v1/teachers/students/:studentId/notes",
  requireSession,
  requireRole("teacher", "approver", "admin"),
  async (req, res) => {
    try {
      const teacherId = getUserId(req);
      if (!teacherId)
        return res.status(401).json({ ok: false, error: "NO_SESSION" });

      const { studentId } = req.params;
      const text =
        typeof req.body?.text === "string" ? req.body.text : "";

      // Verify relationship
      const hasRelationship = await verifyTeacherStudentRelationship(
        teacherId,
        studentId
      );
      if (!hasRelationship) {
        return res.status(403).json({ ok: false, error: "NO_RELATIONSHIP" });
      }

      const r = await withTimeout(
        pool.query(
          `INSERT INTO teacher_student_notes (student_user_id, teacher_user_id, note_text, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, NOW())
           ON CONFLICT (student_user_id, teacher_user_id)
           DO UPDATE SET note_text = EXCLUDED.note_text, updated_at = NOW()
           RETURNING note_text, updated_at`,
          [studentId, teacherId, text]
        ),
        8000,
        "db-upsert-teacher-notes"
      );

      return res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      logger.error("[teachers] update notes failed", {
        err: String(err?.message || err),
      });
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

// ===========================================================================
// PATCH /v1/teachers/students/:studentId/target-level
// Teacher sets a student's CEFR target level (requires allow_teacher_adjust_default)
// ===========================================================================

router.patch(
  "/v1/teachers/students/:studentId/target-level",
  requireSession,
  requireRole("teacher", "approver", "admin"),
  async (req, res) => {
    try {
      const teacherId = getUserId(req);
      if (!teacherId)
        return res.status(401).json({ ok: false, error: "NO_SESSION" });

      const { studentId } = req.params;
      const { cefr_target } = req.body;

      // Validate CEFR level
      const validLevels = ["A1", "A2", "B1", "B2", "C1", "C2"];
      if (cefr_target !== null && !validLevels.includes(cefr_target)) {
        return res.status(400).json({ ok: false, error: "INVALID_LEVEL" });
      }

      // Verify teacher-student relationship
      const hasRelationship = await verifyTeacherStudentRelationship(
        teacherId,
        studentId
      );
      if (!hasRelationship) {
        return res.status(403).json({ ok: false, error: "NO_RELATIONSHIP" });
      }

      // Verify student allows teacher adjustment
      const flagR = await withTimeout(
        pool.query(
          `SELECT allow_teacher_adjust_default FROM users WHERE user_id = $1::uuid`,
          [studentId]
        ),
        8000,
        "db-check-teacher-adjust-flag"
      );
      if (!flagR.rows.length || !Boolean(flagR.rows[0].allow_teacher_adjust_default)) {
        return res.status(403).json({ ok: false, error: "STUDENT_DOES_NOT_ALLOW_ADJUST" });
      }

      // Update
      await withTimeout(
        pool.query(
          `UPDATE users SET cefr_target = $1 WHERE user_id = $2::uuid`,
          [cefr_target, studentId]
        ),
        8000,
        "db-set-student-target-level"
      );

      return res.json({ ok: true, cefr_target });
    } catch (err) {
      logger.error("[teachers] set target level failed", {
        err: String(err?.message || err),
      });
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

module.exports = router;
