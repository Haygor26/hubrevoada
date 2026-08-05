import fs from 'fs';

const FILE = 'F:/CLAUDE/hubrevoada/index.html';
let html = fs.readFileSync(FILE, 'utf8');

// --- 1) limpar o preâmbulo de iframe que veio junto do primeiro publish (não serve pra site standalone) ---
const titleIdx = html.indexOf('<title>Revoada Bafônica');
if (titleIdx === -1) throw new Error('title not found');
const styleStart = html.indexOf('<style>', titleIdx);
const styleEnd = html.indexOf('</style>', styleStart) + '</style>'.length;
const styleBlock = html.slice(styleStart, styleEnd);
const bodyContent = html.slice(styleEnd).replace(/<\/body>\s*<\/html>\s*$/, '');

const newHead =
`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Revoada Bafônica — Hub da Season</title>
${styleBlock}
</head>
<body>`;

html = newHead + bodyContent;

// --- 2) side-nav: dots fixos à direita, com scrollspy ---
const navCss = `
  /* side-nav: navegação rápida fixa à direita */
  .side-nav { position: fixed; right: 22px; top: 50%; transform: translateY(-50%); z-index: 60;
    display: flex; flex-direction: column; gap: 16px; }
  .side-nav a { position: relative; display: block; width: 10px; height: 10px; border-radius: 50%;
    background: var(--surface-2); border: 1px solid var(--line);
    transition: background .25s, box-shadow .25s, transform .25s; }
  .side-nav a:hover, .side-nav a.active { background: var(--accent); transform: scale(1.35);
    box-shadow: 0 0 12px -2px var(--accent); }
  .side-nav a .tip { position: absolute; right: 20px; top: 50%; transform: translateY(-50%);
    white-space: nowrap; background: var(--surface); border: 1px solid var(--line);
    padding: 5px 11px; border-radius: 8px; font-size: .78rem; font-weight: 600; color: var(--text);
    opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; transform-origin: right center; }
  .side-nav a:hover .tip { opacity: 1; }
  .side-nav a.active .tip { color: var(--accent-soft); }
  @media (max-width: 900px) { .side-nav { display: none; } }
`;

// injeta o CSS antes do fechamento do bloco de estilos
html = html.replace('  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }',
  '  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }\n' + navCss);

const navHtml = `
<nav class="side-nav" aria-label="Navegação rápida entre seções">
  <a href="#podio" data-section="podio" title="Pódio"><span class="tip">Pódio</span></a>
  <a href="#plano" data-section="plano" title="Plano da season"><span class="tip">Plano</span></a>
  <a href="#progressao" data-section="progressao" title="Progressão"><span class="tip">Progressão</span></a>
  <a href="#kills" data-section="kills" title="Pulls"><span class="tip">Pulls</span></a>
  <a href="#cronograma" data-section="cronograma" title="Cronograma"><span class="tip">Cronograma</span></a>
  <a href="#roster" data-section="roster" title="Roster"><span class="tip">Roster</span></a>
  <a href="#presenca" data-section="presenca" title="Linha do tempo"><span class="tip">Presença</span></a>
</nav>
`;

html = html.replace('<body>', '<body>\n' + navHtml);

const navJs = `
  // side-nav: scrollspy — marca o dot ativo conforme a seção visível
  (function () {
    var links = document.querySelectorAll('.side-nav a');
    var map = {};
    links.forEach(function (a) { map[a.dataset.section] = a; });
    var sections = Array.prototype.slice.call(document.querySelectorAll('section[id]'));
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var link = map[e.target.id];
        if (!link) return;
        links.forEach(function (l) { l.classList.remove('active'); });
        link.classList.add('active');
      });
    }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
    sections.forEach(function (s) { spy.observe(s); });
  })();
</script>`;

html = html.replace(/<\/script>\s*$/, navJs.replace(/^\n/, '\n') + '\n');

fs.writeFileSync(FILE, html, 'utf8');
console.log('done, bytes=', html.length);
