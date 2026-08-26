/* Admin-visible failure log, backed by the Supabase `error_logs` table (see
   CLAUDE.md's "Error Logs tab" section) — never localStorage/fileData, since
   this exists independently of which business-data backend is active.
   Inserts go through the `log_app_error` RPC (not a direct table insert) so a
   failed login — which happens before any session exists — can still be
   recorded; reads/deletes go straight through the client since those only
   ever run in an already-authenticated admin session. record() must never
   throw: a logging failure must never mask the original error it's attached to. */

const ErrorLog = {
  guessProbableCause(err) {
    const msg = String((err && (err.message || err.error_description)) || err || '');
    const code = err && err.code;
    if (code === '42501') return 'Row-Level Security or table grant denied.';
    if (code === '42P17') return 'Infinite recursion detected in an RLS policy.';
    if (code === 'PGRST202') return 'Function/RPC not found — it may not exist yet, or PostgREST needs a schema reload.';
    if (/failed to fetch|network|NetworkError/i.test(msg)) return 'Network/DNS failure reaching Supabase, or the Project URL is wrong.';
    if (/invalid login credentials/i.test(msg)) return 'Wrong User ID or password.';
    if (/jwt|expired/i.test(msg)) return 'Session expired or invalid — try logging in again.';
    if (code === '23505') return 'Duplicate key / unique constraint violation.';
    return null;
  },

  _detailsFrom(err) {
    if (!err) return null;
    const parts = [];
    if (err.message) parts.push('message: ' + err.message);
    if (err.code) parts.push('code: ' + err.code);
    if (err.hint) parts.push('hint: ' + err.hint);
    if (err.details) parts.push('pg_details: ' + err.details);
    return parts.length ? parts.join(' | ') : String(err);
  },

  async record(message, err, opts) {
    opts = opts || {};
    console.error(message, err);
    try {
      const client = typeof SupabaseClient !== 'undefined' ? SupabaseClient.getClient() : null;
      if (!client) return;
      const { error } = await client.rpc('log_app_error', {
        p_message: String(message || (err && err.message) || 'Unknown error'),
        p_details: opts.details || ErrorLog._detailsFrom(err),
        p_probable_cause: opts.probableCause || ErrorLog.guessProbableCause(err),
        p_source: opts.source || null,
        p_username: opts.username || (typeof currentUser !== 'undefined' && currentUser ? currentUser.username : null),
      });
      if (error) console.warn('Could not write to error_logs', error);
    } catch (e) {
      console.warn('Could not write to error_logs', e);
    }
  },

  async fetchRecent(limit) {
    const client = typeof SupabaseClient !== 'undefined' ? SupabaseClient.getClient() : null;
    if (!client) throw new Error('Supabase is not connected.');
    const { data, error } = await client
      .from('error_logs').select('*')
      .order('created_at', { ascending: false })
      .limit(limit || 200);
    if (error) throw error;
    return data || [];
  },

  async clearOlderThan(days) {
    const client = typeof SupabaseClient !== 'undefined' ? SupabaseClient.getClient() : null;
    if (!client) throw new Error('Supabase is not connected.');
    const cutoff = new Date(Date.now() - Number(days) * 86400000).toISOString();
    const { error } = await client.from('error_logs').delete().lt('created_at', cutoff);
    if (error) throw error;
  },
};
