async function login(){
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value.trim();
  const s = document.getElementById('login-status');
  s.textContent = 'Verificando...'; s.classList.remove('ok','err');
  try{
    const res = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ username:u, password:p }) });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||'Error');
    location.href = '/';
  }catch(e){ s.textContent = e.message; s.classList.add('err'); }
}

document.getElementById('btn-login').addEventListener('click', login);
['username','password'].forEach(id=> document.getElementById(id).addEventListener('keydown', (e)=>{ if(e.key==='Enter') login(); }));
