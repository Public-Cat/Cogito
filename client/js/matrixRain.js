const canvas = document.createElement('canvas');
canvas.style.position = 'fixed';
canvas.style.top = '0';
canvas.style.left = '0';
canvas.style.width = '100%';
canvas.style.height = '100%';
canvas.style.zIndex = '-1';
canvas.style.pointerEvents = 'none';
document.body.prepend(canvas);

const ctx = canvas.getContext('2d');

let columns = [];
let fontSize = 16;

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  columns = [];
  const count = Math.floor(canvas.width / fontSize);
  for (let i = 0; i < count; i++) {
    columns[i] = Math.floor(Math.random() * (canvas.height / fontSize));
  }
}

const chars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF';

function draw() {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#00ff41';
  ctx.font = `${fontSize}px monospace`;

  for (let i = 0; i < columns.length; i++) {
    const char = chars[Math.floor(Math.random() * chars.length)];
    const x = i * fontSize;
    const y = columns[i] * fontSize;
    ctx.fillText(char, x, y);
    if (y > canvas.height && Math.random() > 0.975) {
      columns[i] = 0;
    }
    columns[i]++;
  }
}

window.addEventListener('resize', resize);
resize();
setInterval(draw, 50);
