/*
  TOYBOX — covers.js
  Paints a little landscape picture for each project, so every project card
  looks different even before you add a photo. The same "seed" number always
  paints the same picture.
*/

const Covers = (() => {
  // Six flat, retro poster landscapes: one sky color and three hill layers (far to near).
  // The nearest layer is always dark, so the light giant name on top is easy to read.
  const PALETTES = [
    { kind: 'peak',  sky: '#a9c9d8', hills: ['#f6f2ed', '#cddbe3', '#2f4b5e'] },
    { kind: 'hills', sky: '#e8dcc4', hills: ['#b3c08f', '#78935a', '#33492a'], sun: '#f6f2ed' },
    { kind: 'dunes', sky: '#f3d7b5', hills: ['#e9a35c', '#cf773b', '#7c3a1e'] },
    { kind: 'hills', sky: '#f2b8a5', hills: ['#cd7c8b', '#8c4d6c', '#3f2543'], sun: '#ffe9c8' },
    { kind: 'hills', sky: '#27314b', hills: ['#3b4768', '#232c45', '#141a2b'], moon: '#f6f2ed' },
    { kind: 'dunes', sky: '#ffd21f', hills: ['#f4a623', '#2c2c2c', '#121212'], sun: '#ff3b30' },
  ];

  // A tiny random-number maker that gives the same numbers for the same seed.
  function seededRandom(seed) {
    let t = seed >>> 0;
    return () => {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A wavy ridge line across the picture, closed at the bottom so it can be filled.
  function ridge(rand, baseY, bumpiness, steps) {
    const W = 400, H = 300;
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const x = (W / steps) * i;
      const y = baseY + (rand() - 0.5) * bumpiness * 2;
      points.push([x, y]);
    }
    let d = `M0 ${H} L0 ${points[0][1].toFixed(1)}`;
    for (let i = 1; i < points.length; i++) {
      const [px, py] = points[i - 1];
      const [x, y] = points[i];
      const mx = (px + x) / 2, my = (py + y) / 2;
      d += ` Q${px.toFixed(1)} ${py.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    d += ` L${W} ${points[points.length - 1][1].toFixed(1)} L${W} ${H} Z`;
    return d;
  }

  // One big mountain with a shadow side, like a snowy peak.
  function peak(rand) {
    const top = 70 + rand() * 30;
    const px = 190 + rand() * 80;
    const left = `M-10 300 L-10 ${215 + rand() * 20} L${px - 120} ${150 + rand() * 20} L${px - 40} ${top + 40} L${px} ${top}`;
    const right = `L${px + 70} ${top + 55} L${px + 150} ${125 + rand() * 25} L410 ${150 + rand() * 20} L410 300 Z`;
    const shadow = `M${px} ${top} L${px + 70} ${top + 55} L${px + 150} ${125 + rand() * 10} L410 160 L410 300 L${px + 10} 300 L${px - 15} ${top + 90} Z`;
    return { body: left + ' ' + right, shadow };
  }

  // Build the picture as SVG code (a picture made of shapes).
  function svg(seed, palette) {
    const rand = seededRandom(seed);
    const p = palette != null ? PALETTES[palette % PALETTES.length] : PALETTES[Math.floor(rand() * PALETTES.length)];
    let shapes = '';

    if (p.sun) shapes += `<circle cx="${90 + rand() * 220}" cy="${60 + rand() * 30}" r="${30 + rand() * 12}" fill="${p.sun}"/>`;
    if (p.moon) shapes += `<circle cx="${70 + rand() * 260}" cy="${50 + rand() * 30}" r="${16 + rand() * 8}" fill="${p.moon}"/>`;

    if (p.kind === 'peak') {
      const m = peak(rand);
      shapes += `<path d="${m.body}" fill="${p.hills[0]}"/>`;
      shapes += `<path d="${m.shadow}" fill="${p.hills[1]}"/>`;
      shapes += `<path d="${ridge(rand, 200, 10, 5)}" fill="${p.hills[2]}"/>`;
    } else if (p.kind === 'dunes') {
      shapes += `<path d="${ridge(rand, 120, 34, 3)}" fill="${p.hills[0]}"/>`;
      shapes += `<path d="${ridge(rand, 160, 24, 3)}" fill="${p.hills[1]}"/>`;
      shapes += `<path d="${ridge(rand, 202, 12, 4)}" fill="${p.hills[2]}"/>`;
    } else {
      shapes += `<path d="${ridge(rand, 118, 26, 5)}" fill="${p.hills[0]}"/>`;
      shapes += `<path d="${ridge(rand, 160, 20, 6)}" fill="${p.hills[1]}"/>`;
      shapes += `<path d="${ridge(rand, 202, 12, 6)}" fill="${p.hills[2]}"/>`;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">` +
      `<rect width="400" height="300" fill="${p.sky}"/>${shapes}</svg>`;
  }

  // The picture as a URL that an <img> can show.
  function url(seed, palette) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg(seed, palette));
  }

  // The picture as a square PNG, for the lock screen and headphone "now playing" card.
  function png(src, size = 512) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        try {
          canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), 'image/png');
        } catch (error) {
          resolve(null); // some browsers won't turn certain pictures into PNGs; the card just has no art
        }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

  return { url, png, randomSeed, count: PALETTES.length };
})();
