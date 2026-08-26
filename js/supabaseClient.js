/* Supabase identity/auth layer. Login credentials live only in Supabase Auth's
   own auth.users table (hashed by Supabase itself) — never in this app's files.
   This is also the module storage.js's Supabase data backend (js/storage.js,
   "SUPABASE DATA BACKEND" section) reaches into via getClient(), so that both
   auth calls and business_data reads/writes share one authenticated session —
   RLS on business_data requires auth.uid() to be set, which only happens
   through the session established by signIn() below. */

const SUPABASE_EMAIL_DOMAIN = 'app.local';

let sbClient = null;
let sbClientConfig = null;

function usernameToEmail(username) {
  return String(username || '').trim().toLowerCase() + '@' + SUPABASE_EMAIL_DOMAIN;
}

function emailToUsername(email) {
  return String(email || '').split('@')[0];
}

const SupabaseClient = {
  init(url, anonKey) {
    if (!url || !anonKey) { sbClient = null; sbClientConfig = null; return null; }
    if (sbClient && sbClientConfig && sbClientConfig.url === url && sbClientConfig.anonKey === anonKey) {
      return sbClient;
    }
    sbClient = supabase.createClient(url, anonKey, { auth: { persistSession: false } });
    sbClientConfig = { url, anonKey };
    return sbClient;
  },

  getClient() {
    return sbClient;
  },

  isInitialized() {
    return !!sbClient;
  },

  async signOut() {
    if (sbClient) await sbClient.auth.signOut();
  },

  async signIn(username, password) {
    if (!sbClient) throw new Error('Supabase is not configured yet.');
    const { data, error } = await sbClient.auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    });
    if (error) {
      ErrorLog.record('Login failed', error, { source: 'SupabaseClient.signIn', username });
      throw error;
    }
    return data.user;
  },

  async getMyProfile() {
    const { data: authData, error: authError } = await sbClient.auth.getUser();
    if (authError) {
      ErrorLog.record('Could not load the logged-in user\'s profile', authError, { source: 'SupabaseClient.getMyProfile' });
      throw authError;
    }
    const { data, error } = await sbClient.from('profiles').select('*').eq('id', authData.user.id).single();
    if (error) {
      ErrorLog.record('Could not load the logged-in user\'s profile', error, { source: 'SupabaseClient.getMyProfile' });
      throw error;
    }
    return { username: data.username, isAdmin: !!data.is_admin, isViewer: !!data.is_viewer };
  },

  async listProfiles() {
    const { data, error } = await sbClient.from('profiles').select('*').order('username');
    if (error) {
      ErrorLog.record('Could not load the user list', error, { source: 'SupabaseClient.listProfiles' });
      throw error;
    }
    return (data || []).map((p) => ({ username: p.username, isAdmin: !!p.is_admin, isViewer: !!p.is_viewer }));
  },

  async createUser(username, password, isAdmin) {
    const { error } = await sbClient.rpc('admin_create_user', {
      p_username: username, p_password: password, p_is_admin: !!isAdmin,
    });
    if (error) {
      ErrorLog.record('Could not create user "' + username + '"', error, { source: 'SupabaseClient.createUser', username });
      throw error;
    }
  },

  async resetPassword(username, newPassword) {
    const { error } = await sbClient.rpc('admin_reset_password', {
      p_username: username, p_new_password: newPassword,
    });
    if (error) {
      ErrorLog.record('Could not reset password for "' + username + '"', error, { source: 'SupabaseClient.resetPassword', username });
      throw error;
    }
  },

  async deleteUser(username) {
    const { error } = await sbClient.rpc('admin_delete_user', { p_username: username });
    if (error) {
      ErrorLog.record('Could not delete user "' + username + '"', error, { source: 'SupabaseClient.deleteUser', username });
      throw error;
    }
  },

  async setAdminFlag(username, isAdmin) {
    const { error } = await sbClient.from('profiles').update({ is_admin: !!isAdmin }).eq('username', username);
    if (error) {
      ErrorLog.record('Could not update admin role for "' + username + '"', error, { source: 'SupabaseClient.setAdminFlag', username });
      throw error;
    }
  },

  async setViewerFlag(username, isViewer) {
    const { error } = await sbClient.from('profiles').update({ is_viewer: !!isViewer }).eq('username', username);
    if (error) {
      ErrorLog.record('Could not update viewer role for "' + username + '"', error, { source: 'SupabaseClient.setViewerFlag', username });
      throw error;
    }
  },
};
