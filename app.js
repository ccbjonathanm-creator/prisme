/* ===========================================================
   Prisme — logique de l'app
   Flux : capture (caméra/photo) -> OCR local (Tesseract) -> action
   Actions : Résumer / Expliquer / Traduire (IA)  +  Extraire (100% local)
   Cerveau IA au choix : Gemini, Groq (clé de l'utilisateur, stockée sur l'appareil)
   =========================================================== */

const APP_VERSION = 'v2';

/* -------------------- État & stockage -------------------- */
const LS_KEY = 'prisme_settings_v1';
const state = {
  provider: 'gemini',
  keys: { gemini: '', groq: '' },
  targetLang: 'Français',
  ocrText: '',
  imgDataUrl: '',
};

function loadSettings(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){
      const s = JSON.parse(raw);
      state.provider = s.provider || 'gemini';
      state.keys = Object.assign({gemini:'',groq:''}, s.keys || {});
      state.targetLang = s.targetLang || 'Français';
    }
  }catch(e){ /* premier lancement */ }
}
function saveSettings(){
  localStorage.setItem(LS_KEY, JSON.stringify({
    provider: state.provider, keys: state.keys, targetLang: state.targetLang
  }));
}

/* -------------------- Raccourcis DOM -------------------- */
const $ = (id)=>document.getElementById(id);
const screens = {
  capture: $('screen-capture'),
  analyze: $('screen-analyze'),
  result:  $('screen-result'),
};
function show(name){
  Object.entries(screens).forEach(([k,el])=>el.classList.toggle('hidden', k!==name));
}
function toast(msg, ms=2600){
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(()=>t.classList.add('hidden'), ms);
}

/* -------------------- Caméra -------------------- */
let stream = null, facing = 'environment';
async function startCamera(){
  stopCamera();
  try{
    stream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode: facing, width:{ideal:1920}, height:{ideal:1080} }, audio:false
    });
    const v = $('cam'); v.srcObject = stream; await v.play().catch(()=>{});
    $('cam-hint').classList.remove('hidden');
  }catch(e){
    // Pas de caméra (ou refus) : on bascule sur le mode galerie sans bloquer l'app.
    $('cam-hint').classList.remove('hidden');
    $('cam-hint').innerHTML = '<p>Caméra indisponible</p><span>Utilise le bouton galerie pour choisir une photo</span>';
  }
}
function stopCamera(){
  if(stream){ stream.getTracks().forEach(t=>t.stop()); stream = null; }
}

/* Capture d'une image de la vidéo -> dataURL */
function shootFromVideo(){
  const v = $('cam');
  if(!v.videoWidth){ toast('Caméra pas prête, réessaie'); return null; }
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  return c.toDataURL('image/jpeg', 0.92);
}

/* Réduit une image (dataURL) pour l'OCR/IA : plus rapide, suffisant */
function downscale(dataUrl, maxSide=1600){
  return new Promise((res)=>{
    const img = new Image();
    img.onload = ()=>{
      let {width:w, height:h} = img;
      const scale = Math.min(1, maxSide/Math.max(w,h));
      const c = document.createElement('canvas');
      c.width = Math.round(w*scale); c.height = Math.round(h*scale);
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      res(c.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = ()=>res(dataUrl);
    img.src = dataUrl;
  });
}

/* Prépare l'image POUR L'OCR : grand format + niveaux de gris + contraste étiré.
   On renvoie un CANVAS passé tel quel à Tesseract (aucune recompression JPEG,
   donc zéro artefact qui brouille les petits chiffres). */
function prepareForOCR(dataUrl, target=2400){
  return new Promise((res)=>{
    const img = new Image();
    img.onload = ()=>{
      let {width:w, height:h} = img;
      // Vise ~2400 px de grand côté : réduit les grosses photos, agrandit un peu les petites (x2 max).
      let scale = target/Math.max(w,h);
      scale = Math.min(scale, 2);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w*scale));
      c.height = Math.max(1, Math.round(h*scale));
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      try{
        const im = ctx.getImageData(0,0,c.width,c.height);
        const px = im.data;
        // 1) luminance (gris) + histogramme
        const gray = new Uint8ClampedArray(px.length/4);
        const hist = new Uint32Array(256);
        for(let i=0,j=0;i<px.length;i+=4,j++){
          const g = (px[i]*0.299 + px[i+1]*0.587 + px[i+2]*0.114)|0;
          gray[j]=g; hist[g]++;
        }
        // 2) bornes de contraste aux 2e/98e centiles (ignore les extrêmes)
        const total = gray.length;
        let cum=0, min=0, max=255;
        for(let v=0;v<256;v++){ cum+=hist[v]; if(cum>=0.02*total){ min=v; break; } }
        cum=0; for(let v=255;v>=0;v--){ cum+=hist[v]; if(cum>=0.02*total){ max=v; break; } }
        const range = Math.max(1, max-min);
        // 3) étirement du contraste sur toute la plage
        for(let i=0,j=0;i<px.length;i+=4,j++){
          let g = (gray[j]-min)*255/range;
          g = g<0?0:g>255?255:g;
          px[i]=px[i+1]=px[i+2]=g;
        }
        ctx.putImageData(im,0,0);
      }catch(e){ /* getImageData indispo : on garde l'image gris/couleur redimensionnée */ }
      res(c);
    };
    img.onerror = ()=>res(dataUrl); // repli : Tesseract accepte aussi le dataURL
    img.src = dataUrl;
  });
}

/* -------------------- OCR local (Tesseract embarqué) -------------------- */
let ocrWorker = null;
async function getOcrWorker(){
  if(ocrWorker) return ocrWorker;
  // URL absolues : le worker Tesseract tourne dans un blob sans base, les chemins relatifs y échouent.
  const abs = (p)=> new URL(p, location.href).href;
  ocrWorker = await Tesseract.createWorker(['fra','eng'], 1, {
    workerPath: abs('vendor/worker.min.js'),
    corePath:   abs('vendor/tesseract-core-simd.wasm.js'),
    langPath:   abs('vendor/lang'),
    gzip: true,
  });
  // Réglages qui fiabilisent la lecture (DPI supposé, espaces conservés).
  try{ await ocrWorker.setParameters({ user_defined_dpi:'300', preserve_interword_spaces:'1' }); }
  catch(e){ /* non bloquant */ }
  return ocrWorker;
}
async function runOCR(source){
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(source);
  return (data.text || '').trim();
}

/* -------------------- Extraction locale (regex, 0 IA, hors-ligne) -------------------- */
const MOIS = 'janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre';
function uniq(arr){ return [...new Set(arr.map(s=>s.trim()))].filter(Boolean); }

function extractLocal(text){
  const t = text.replace(/ /g,' ');
  const out = {};

  // Montants en euros (12,50 €  /  1 234.00 EUR  /  €12)
  out.montants = uniq((t.match(/(?:€\s?)?\d{1,3}(?:[ .]\d{3})*(?:[.,]\d{2})?\s?(?:€|eur|euros?)|\d+[.,]\d{2}\s?(?:€|eur)/gi) || []));

  // Dates chiffrées et littérales
  const d1 = t.match(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/g) || [];
  const d2 = t.match(new RegExp(`\\b\\d{1,2}(?:er)?\\s(?:${MOIS})\\s\\d{4}\\b`,'gi')) || [];
  out.dates = uniq([...d1, ...d2]);

  // Échéances / dates limites (phrase autour d'un mot déclencheur)
  const ech = [];
  const reEch = new RegExp(`(?:avant le|au plus tard le|date limite|échéance|à régler avant|payable avant)[^\\n.]{0,40}`,'gi');
  let m; while((m = reEch.exec(t))) ech.push(m[0]);
  out.echeances = uniq(ech);

  // IBAN (FR + international simplifié)
  out.iban = uniq((t.match(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}\b/g) || []));

  // Emails
  out.emails = uniq((t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []));

  // Téléphones FR (bornés par des non-chiffres pour ne pas mordre dans un IBAN)
  out.tels = uniq((t.match(/(?<!\d)(?:(?:\+33|0033)\s?[1-9]|0[1-9])(?:[\s.-]?\d{2}){4}(?!\d)/g) || []));

  // Références / numéros de dossier : on ne garde que les identifiants qui contiennent un chiffre
  // (évite d'attraper un mot déclencheur voisin comme « dossier »).
  const refs = [];
  // Déclencheur, éventuel mot intermédiaire (« dossier »…), puis un identifiant qui DOIT contenir un chiffre.
  const reRef = /(?:r[ée]f[ée]rence|dossier|n°|no|contrat|client|facture)\s*(?:[a-zà-ÿ]+\s+)?[:#]?\s*([A-Z0-9][A-Z0-9\/-]*\d[A-Z0-9\/-]*)/gi;
  while((m = reRef.exec(t))){ refs.push(m[0].replace(/\s+/g,' ').trim()); }
  out.refs = uniq(refs);

  return out;
}

/* -------------------- Appels IA (mode en ligne) -------------------- */
function promptFor(action, text){
  const base = `Voici le texte d'un document scanné :\n"""\n${text}\n"""\n\n`;
  if(action==='resumer')
    return base + "Résume ce document en français, en 3 à 5 phrases claires. Va à l'essentiel, pas de préambule.";
  if(action==='expliquer')
    return base + "Explique ce document en français très simple, comme à quelqu'un qui n'y connaît rien. Dis : 1) ce que c'est, 2) ce que ça implique pour la personne, 3) ce qu'elle doit faire concrètement et pour quand. Sois concret et rassurant, sans jargon.";
  if(action==='traduire')
    return base + `Traduis fidèlement ce texte en ${state.targetLang}. Donne uniquement la traduction, sans commentaire.`;
  return base + "Résume ce document.";
}

async function callGemini(prompt){
  const key = state.keys.gemini;
  if(!key) throw new Error('NO_KEY');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ contents:[{ parts:[{ text: prompt }] }] })
  });
  if(!r.ok){ throw new Error('HTTP_'+r.status); }
  const j = await r.json();
  const txt = j?.candidates?.[0]?.content?.parts?.map(p=>p.text).join('') || '';
  if(!txt) throw new Error('EMPTY');
  return txt.trim();
}

async function callGroq(prompt){
  const key = state.keys.groq;
  if(!key) throw new Error('NO_KEY');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
    body: JSON.stringify({
      model:'llama-3.3-70b-versatile',
      messages:[{role:'user', content: prompt}],
      temperature:0.3
    })
  });
  if(!r.ok){ throw new Error('HTTP_'+r.status); }
  const j = await r.json();
  const txt = j?.choices?.[0]?.message?.content || '';
  if(!txt) throw new Error('EMPTY');
  return txt.trim();
}

async function callAI(action){
  const prompt = promptFor(action, state.ocrText);
  if(state.provider==='groq')   return callGroq(prompt);
  return callGemini(prompt);
}

/* -------------------- Rendu résultat -------------------- */
const ACTION_META = {
  resumer:  { title:'Résumé',       emoji:'📝' },
  expliquer:{ title:'Explication',  emoji:'💡' },
  traduire: { title:'Traduction',   emoji:'🌍' },
  extraire: { title:'Infos clés',   emoji:'🔍' },
};
function providerLabel(){
  return state.provider==='groq' ? 'Groq' : 'Gemini';
}

async function doAction(action){
  const meta = ACTION_META[action];
  $('result-title').textContent = meta.title;
  $('result-badge').textContent = action==='extraire' ? 'hors-ligne' : providerLabel();
  const body = $('result-body');
  show('result');

  if(action==='extraire'){
    renderExtraction(extractLocal(state.ocrText), body);
    return;
  }

  // Actions IA
  if(!state.keys[state.provider]){
    body.innerHTML = `<p class="empty">Il manque ta clé ${providerLabel()}. Ouvre les réglages (roue crantée en haut) pour la coller, c'est gratuit.</p>`;
    return;
  }

  body.innerHTML = `<span class="typing">Analyse en cours</span>`;
  try{
    const txt = await callAI(action);
    body.textContent = txt;
  }catch(err){
    body.innerHTML = renderError(err);
  }
}

function renderExtraction(x, body){
  const rows = [];
  const add = (label, arr)=>{ if(arr && arr.length) rows.push(
    `<div class="kv"><span class="k">${label}</span><span class="v">${arr.map(esc).join('<br>')}</span></div>`
  ); };
  add('Dates', x.dates);
  add('Échéances', x.echeances);
  add('Montants', x.montants);
  add('IBAN', x.iban);
  add('Références', x.refs);
  add('Emails', x.emails);
  add('Téléphones', x.tels);
  body.innerHTML = rows.length
    ? rows.join('')
    : `<p class="empty">Aucune date, montant ou coordonnée détectés dans ce document.</p>`;
}

function renderError(err){
  const m = String(err.message||err);
  if(m==='NO_KEY') return `<p class="empty">Clé manquante. Ajoute-la dans les réglages.</p>`;
  if(m==='HTTP_400') return `<p class="empty">Requête refusée (clé invalide ?). Vérifie ta clé dans les réglages.</p>`;
  if(m==='HTTP_401'||m==='HTTP_403') return `<p class="empty">Clé refusée. Recolle une clé valide dans les réglages.</p>`;
  if(m==='HTTP_429') return `<p class="empty">Quota atteint pour l'instant. Réessaie dans un moment ou change de cerveau (Gemini/Groq).</p>`;
  if(m==='EMPTY') return `<p class="empty">L'IA n'a rien renvoyé. Réessaie.</p>`;
  return `<p class="empty">Souci de connexion (${esc(m)}). Vérifie ta connexion et réessaie.</p>`;
}

function esc(s){ return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

/* -------------------- Pipeline capture -> analyse -------------------- */
async function handleImage(dataUrl){
  const small = await downscale(dataUrl);
  state.imgDataUrl = small;
  $('preview-img').src = small;
  stopCamera();
  show('analyze');
  // reset UI analyse
  $('ocr-status').classList.remove('hidden');
  $('actions').classList.add('hidden');
  $('raw-text').classList.add('hidden');

  try{
    const ocrSource = await prepareForOCR(dataUrl); // image dédiée OCR (grande, gris, contrastée)
    const text = await runOCR(ocrSource);
    state.ocrText = text;
    $('raw-pre').textContent = text || '(aucun texte détecté)';
    $('raw-count').textContent = text ? `(${text.length} car.)` : '';
    $('ocr-status').classList.add('hidden');
    $('actions').classList.remove('hidden');
    $('raw-text').classList.remove('hidden');
    if(!text) toast("Peu de texte lisible. Rapproche-toi ou éclaire mieux.");
  }catch(err){
    $('ocr-status').innerHTML = `<span>Lecture impossible. Reprends la photo.</span>`;
  }
}

/* -------------------- Réglages (feuille) -------------------- */
const KEY_HELP = {
  gemini:{ url:'https://aistudio.google.com/apikey', label:'Créer ma clé Gemini gratuite (Google AI Studio)' },
  groq:{ url:'https://console.groq.com/keys', label:'Créer ma clé Groq gratuite (console.groq.com)' },
};
function openSheet(){
  // pré-remplir selon l'état
  document.querySelectorAll('input[name="provider"]').forEach(r=>{ r.checked = (r.value===state.provider); });
  syncKeyBlock();
  $('sheet-backdrop').classList.remove('hidden');
  $('sheet').classList.remove('hidden');
}
function closeSheet(){
  $('sheet-backdrop').classList.add('hidden');
  $('sheet').classList.add('hidden');
}
function currentProviderChoice(){
  const r = document.querySelector('input[name="provider"]:checked');
  return r ? r.value : 'gemini';
}
function syncKeyBlock(){
  const p = currentProviderChoice();
  const block = $('key-block');
  block.style.display='';
  $('key-label').textContent = `Clé ${p==='gemini'?'Gemini':'Groq'}`;
  $('key-input').value = state.keys[p] || '';
  $('key-help').textContent = KEY_HELP[p].label;
  $('key-help').href = KEY_HELP[p].url;
}
function saveSheet(){
  const p = currentProviderChoice();
  state.provider = p;
  state.keys[p] = $('key-input').value.trim();
  saveSettings();
  updateEnginePill();
  closeSheet();
  toast('Réglages enregistrés');
}
function updateEnginePill(){
  const p = state.provider;
  const name = p==='groq' ? 'Groq' : 'Gemini';
  const ok = !!state.keys[p];
  $('engine-pill').innerHTML = `Cerveau : <b>${name}</b>` + (ok ? ' · prêt' : ' · clé requise');
}

/* -------------------- Copier / Partager -------------------- */
async function copyResult(){
  const txt = $('result-body').innerText;
  try{ await navigator.clipboard.writeText(txt); toast('Copié'); }
  catch(e){ toast('Copie impossible'); }
}
async function shareResult(){
  const txt = $('result-body').innerText;
  const title = $('result-title').textContent;
  if(navigator.share){ try{ await navigator.share({ title:'Prisme — '+title, text:txt }); }catch(e){} }
  else { copyResult(); }
}

/* -------------------- Câblage des événements -------------------- */
function wire(){
  $('btn-shoot').addEventListener('click', ()=>{
    const d = shootFromVideo(); if(d) handleImage(d);
  });
  $('btn-gallery').addEventListener('click', ()=> $('file-input').click());
  $('file-input').addEventListener('change', (e)=>{
    const f = e.target.files && e.target.files[0]; if(!f) return;
    const rd = new FileReader();
    rd.onload = ()=>handleImage(rd.result);
    rd.readAsDataURL(f);
    e.target.value='';
  });
  $('btn-flip').addEventListener('click', ()=>{ facing = facing==='environment'?'user':'environment'; startCamera(); });

  $('btn-retake').addEventListener('click', backToCapture);
  $('btn-new').addEventListener('click', backToCapture);
  $('btn-result-back').addEventListener('click', ()=>show('analyze'));

  document.querySelectorAll('.action').forEach(b=>{
    b.addEventListener('click', ()=>doAction(b.dataset.action));
  });

  $('btn-copy').addEventListener('click', copyResult);
  $('btn-share').addEventListener('click', shareResult);

  // Réglages
  $('btn-settings').addEventListener('click', openSheet);
  $('engine-pill').addEventListener('click', openSheet);
  $('sheet-backdrop').addEventListener('click', closeSheet);
  $('btn-settings-save').addEventListener('click', saveSheet);
  document.querySelectorAll('input[name="provider"]').forEach(r=> r.addEventListener('change', syncKeyBlock));
  $('key-eye').addEventListener('click', ()=>{
    const i = $('key-input'); i.type = i.type==='password'?'text':'password';
  });

  $('version-line').textContent = 'Prisme '+APP_VERSION;
}

function backToCapture(){
  state.ocrText=''; state.imgDataUrl='';
  show('capture');
  startCamera();
}

/* -------------------- Démarrage -------------------- */
function init(){
  loadSettings();
  wire();
  updateEnginePill();
  show('capture');
  startCamera();

  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}
document.addEventListener('DOMContentLoaded', init);
