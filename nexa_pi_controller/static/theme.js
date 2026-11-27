(() => {
  const themes = {
    dark: {background: '#121417', cards: '#1c1f24', text: '#f1f3f5', accent: '#15803d'},
    light: {background: '#f4f5f7', cards: '#ffffff', text: '#1c1e21', accent: '#15803d'},
    ocean: {background: '#10212d', cards: '#1a3040', text: '#e8f4fb', accent: '#0284c7'},
    forest: {background: '#142119', cards: '#1f3025', text: '#edf5ee', accent: '#16803d'},
    sage: {
      background: '#fbf8e8', cards: '#fffdee', text: '#2d3829', accent: '#4a6034',
      muted: '#66715f', btn: '#eeeedb', line: '#899572',
      shadow: '0 12px 30px rgba(45, 56, 41, .12)',
      backgroundImage: 'linear-gradient(180deg, #c5d4c5 0%, #e8e8cb 18%, #fbf8e8 31%, #fbf8e8 100%)',
    },
  };
  const styleProperties = ['--bg', '--card', '--text', '--muted', '--on', '--primary',
    '--btn', '--line', '--shadow', '--accent-contrast'];

  function colorToHex(value, fallback = '#121417') {
    if (typeof value !== 'string') return fallback;
    const hex = value.trim().match(/^#[\da-f]{6}$/i);
    if (hex) return hex[0].toLowerCase();
    const rgb = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (!rgb) return fallback;
    return `#${rgb.slice(1, 4).map(channel =>
      Number(channel).toString(16).padStart(2, '0')).join('')}`;
  }

  function readSystemPalette() {
    const styles = getComputedStyle(document.documentElement);
    return {
      background: colorToHex(styles.getPropertyValue('--bg')),
      cards: colorToHex(styles.getPropertyValue('--card'), '#1c1f24'),
      text: colorToHex(styles.getPropertyValue('--text'), '#f1f3f5'),
      accent: colorToHex(styles.getPropertyValue('--primary'), '#15803d'),
    };
  }

  function load() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem('nexa-appearance') || '{}') || {};
    } catch (_) {}
    const system = readSystemPalette();
    const storedPalette = saved.custom || {};
    const usedIds = new Set();
    const savedThemes = Array.isArray(saved.savedThemes)
      ? saved.savedThemes.filter(item => {
        if (!item || typeof item.id !== 'string' || !/^[a-z\d_-]+$/i.test(item.id)
            || typeof item.name !== 'string' || !item.name.trim() || usedIds.has(item.id)) return false;
        usedIds.add(item.id);
        return true;
      }).map(item => ({
        id: item.id,
        name: item.name.trim().slice(0, 40),
        palette: {
          background: colorToHex(item.palette?.background, system.background),
          cards: colorToHex(item.palette?.cards, system.cards),
          text: colorToHex(item.palette?.text, system.text),
          accent: colorToHex(item.palette?.accent, system.accent),
        },
      }))
      : [];
    const builtInThemes = ['system', 'dark', 'light', 'ocean', 'forest', 'sage', 'custom'];
    return {
      theme: (builtInThemes.includes(saved.theme)
        || savedThemes.some(item => saved.theme === `saved:${item.id}`)) ? saved.theme : 'system',
      custom: {
        background: colorToHex(storedPalette.background, system.background),
        cards: colorToHex(storedPalette.cards, system.cards),
        text: colorToHex(storedPalette.text, system.text),
        accent: colorToHex(storedPalette.accent, system.accent),
      },
      customEdited: saved.customEdited === true || saved.theme === 'custom',
      savedThemes,
    };
  }

  function paletteForTheme(theme, appearance) {
    if (theme === 'system') return readSystemPalette();
    if (theme === 'custom') return {...appearance.custom};
    if (theme.startsWith('saved:')) {
      const savedTheme = appearance.savedThemes.find(item => item.id === theme.slice(6));
      if (savedTheme) return {...savedTheme.palette};
    }
    return {...themes[theme]};
  }

  function apply(appearance) {
    const root = document.documentElement;
    if (appearance.theme === 'system') {
      styleProperties.forEach(name => root.style.removeProperty(name));
      if (document.body) document.body.style.removeProperty('background-image');
      return;
    }
    const palette = paletteForTheme(appearance.theme, appearance);
    root.style.setProperty('--bg', palette.background);
    root.style.setProperty('--card', palette.cards);
    root.style.setProperty('--text', palette.text);
    root.style.setProperty('--primary', palette.accent);
    root.style.setProperty('--on', palette.accent);
    root.style.setProperty('--btn', palette.btn || 'color-mix(in srgb, var(--card) 88%, var(--text))');
    root.style.setProperty('--line', palette.line || 'color-mix(in srgb, var(--card) 78%, var(--text))');
    root.style.setProperty('--muted', palette.muted || 'color-mix(in srgb, var(--text) 62%, var(--bg))');
    if (palette.shadow) root.style.setProperty('--shadow', palette.shadow);
    else root.style.removeProperty('--shadow');
    if (document.body) {
      if (palette.backgroundImage) document.body.style.backgroundImage = palette.backgroundImage;
      else document.body.style.removeProperty('background-image');
    }
    const channels = [1, 3, 5].map(index => parseInt(palette.accent.slice(index, index + 2), 16) / 255);
    const luminance = channels.reduce((sum, channel, index) => {
      const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      return sum + linear * [0.2126, 0.7152, 0.0722][index];
    }, 0);
    root.style.setProperty('--accent-contrast', luminance > 0.45 ? '#121417' : '#ffffff');
  }

  function applyStored() {
    apply(load());
  }

  window.NexaAppearance = {apply, applyStored, load, paletteForTheme, readSystemPalette};
  if (document.currentScript?.dataset.autoload === 'true') applyStored();
})();
