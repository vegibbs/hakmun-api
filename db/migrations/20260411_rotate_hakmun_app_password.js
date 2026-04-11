module.exports.up = async (client) => {
  const newPw = process.env.HAKMUN_APP_DB_PASSWORD;
  if (!newPw) throw new Error("HAKMUN_APP_DB_PASSWORD not set");
  const escaped = newPw.replace(/'/g, "''");
  await client.query(`ALTER USER hakmun_app WITH PASSWORD '${escaped}'`);
};
