// Readiness: can this process do its job right now? That means it can reach the database, so the check
// runs a real query through the same pool the application uses. Returns a result, never throws.
export async function checkHealth({ query, timeoutMs = 3000, startedAt = Date.now(), now = Date.now }) {
  const began = now();
  let timer;
  try {
    await Promise.race([
      query('select 1'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('database check timed out')), timeoutMs); }),
    ]);
    return { ok: true, body: { status: 'ok', db: 'ok', dbLatencyMs: now() - began, uptimeSeconds: Math.round((now() - startedAt) / 1000) }, error: null };
  } catch (error) {
    // The body is public: say which part is down, never why. The reason goes to the log.
    return { ok: false, body: { status: 'unavailable', db: 'down' }, error };
  } finally {
    clearTimeout(timer);
  }
}
