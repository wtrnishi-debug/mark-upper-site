const MU_URL = 'https://hiccejzetnmmvyopyykw.supabase.co';
const MU_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpY2NlanpldG5tbXZ5b3B5eWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4MjkwMTYsImV4cCI6MjA5NDQwNTAxNn0.Oo_KrFflZhhWOlaN_hT9XZpBjhDFAgccK82CyrgC3qU';
const mu_sb = supabase.createClient(MU_URL, MU_KEY);

async function mu_getOrCreateSession(domain) {
  const { data: existing } = await mu_sb
    .from('mu_sessions').select('*')
    .eq('domain', domain)
    .order('created_at', { ascending: false })
    .limit(1).single();
  if (existing) return existing;
  const { data, error } = await mu_sb
    .from('mu_sessions').insert({ domain }).select().single();
  if (error) throw error;
  return data;
}

async function mu_getSessionById(id) {
  const { data } = await mu_sb
    .from('mu_sessions').select('*').eq('id', id).single();
  return data;
}

async function mu_getComments(sessionId) {
  const { data } = await mu_sb
    .from('mu_comments').select('*')
    .eq('session_id', sessionId)
    .order('created_at');
  return data || [];
}

async function mu_getReplies(commentId) {
  const { data } = await mu_sb
    .from('mu_comments').select('*')
    .eq('parent_id', commentId).order('created_at');
  return data || [];
}

async function mu_addComment({ session_id, page_url, x_percent, y_percent, breakpoint, text, author, status = 'open', parent_id = null }) {
  const { data, error } = await mu_sb
    .from('mu_comments')
    .insert({ session_id, page_url, x_percent, y_percent, breakpoint, text, author, status, parent_id })
    .select().single();
  if (error) return null;
  return data;
}

async function mu_updateStatus(commentId, status) {
  await mu_sb.from('mu_comments').update({ status }).eq('id', commentId);
}

async function mu_deleteComment(commentId) {
  await mu_sb.from('mu_comments').delete().eq('id', commentId);
}
