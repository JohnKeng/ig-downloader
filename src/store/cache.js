const fs = require('fs');

class Cache {
  constructor(filePath) {
    this.filePath = filePath;
    this.map = new Set();
    this._loaded = false;
  }

  load() {
    if (this._loaded) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const obj = JSON.parse(raw || '{}');
      Object.keys(obj).forEach((k) => this.map.add(k));
    } catch (_) {
      // ignore
    }
    this._loaded = true;
  }

  has(key) {
    this.load();
    return this.map.has(key);
  }

  add(key) {
    this.load();
    this.map.add(key);
  }

  save() {
    this.load();
    const obj = {};
    for (const k of this.map) obj[k] = true;
    fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
  }
}

module.exports = { Cache };
