// util/audit.js — HakMun API
// Append-only audit log writer for SOC2 compliance.
//
// Writes to the audit_log table. hakmun_app (app runtime user) has INSERT
// only — no UPDATE or DELETE. Failures are logged but never throw, so
// audit errors never break request handling.
//
// Usage:
//   const { audit } = require('../util/audit');
//   await audit(req, 'user.signin', 'user', userId, { provider: 'apple' });
//
// action naming convention: '<domain>.<event>'
//   user.signup, user.signin, user.signout
//   profile.update, profile.photo_upload
//   admin.action, admin.flag_user
//   library.moderate, library.grant_access
//   account.deactivate

'use strict';

const { pool } = require('../db/pool');
const { logger } = require('./log');

/**
 * Write an audit event.
 *
 * @param {object|null} req        - Express request (for IP extraction), or null
 * @param {string}      action     - Event name e.g. 'user.signin'
 * @param {string|null} targetType - Type of the affected entity e.g. 'user'
 * @param {string|null} targetId   - ID of the affected entity
 * @param {object}      details    - Additional context (never include secrets)
 * @param {string|null} actorId    - UUID of acting user (overrides req.user?.user_id)
 */
async function audit(req, action, targetType, targetId, details = {}, actorId = null) {
  try {
    const userId = actorId ?? req?.user?.userID ?? null;
    const ip = extractIp(req);

    await pool.query(
      `INSERT INTO audit_log (actor_user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, action, targetType ?? null, targetId ? String(targetId) : null, JSON.stringify(details), ip]
    );
  } catch (err) {
    // Audit failures must never crash request handling
    logger.error('[audit] write failed', { action, error: err.message });
  }
}

function extractIp(req) {
  if (!req) return null;
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? null;
}

module.exports = { audit };
