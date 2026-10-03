/* Entschlüsselt die Video-Reports im Browser (sie liegen nur verschlüsselt auf GitHub).
   Gegenstück zu publish.py: PBKDF2-SHA256 -> AES-256-CBC + HMAC-SHA256. */
window.BCLock = (function () {
  var KEY = "bc-report-pw";
  var b64 = function (s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); };
  function stored() {
    try { return sessionStorage.getItem(KEY) || localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function remember(pw, keep) {
    try { sessionStorage.setItem(KEY, pw); if (keep) localStorage.setItem(KEY, pw); } catch (e) {}
  }
  function forget() {
    try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch (e) {}
  }
  async function decrypt(b, pw) {
    var s = crypto.subtle, salt = b64(b.salt), iv = b64(b.iv), ct = b64(b.ct), mac = b64(b.mac);
    var base = await s.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
    var bits = new Uint8Array(await s.deriveBits({ name: "PBKDF2", salt: salt, iterations: b.iter, hash: "SHA-256" }, base, 512));
    var macKey = await s.importKey("raw", bits.slice(32), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    var signed = new Uint8Array(iv.length + ct.length); signed.set(iv); signed.set(ct, iv.length);
    if (!(await s.verify("HMAC", macKey, mac, signed))) throw new Error("Falsches Passwort");
    var aes = await s.importKey("raw", bits.slice(0, 32), "AES-CBC", false, ["decrypt"]);
    return new TextDecoder().decode(await s.decrypt({ name: "AES-CBC", iv: iv }, aes, ct));
  }
  async function load(url, pw) {
    var r = await fetch(url + (url.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("nicht gefunden");
    return decrypt(await r.json(), pw);
  }
  // Kleines Passwortformular in ein Element setzen; onOk(pw) bekommt das (geprüfte) Passwort
  function form(el, test, onOk, msg) {
    el.innerHTML = '<form class="lock"><span>🔒 ' + (msg || "Passwortgeschützt") + '</span>' +
      '<input type="password" autocomplete="current-password" placeholder="Passwort" required>' +
      '<label><input type="checkbox"> auf diesem Gerät merken</label><button>Entsperren</button><em></em></form>';
    var f = el.querySelector("form");
    f.onsubmit = async function (e) {
      e.preventDefault();
      var pw = f.querySelector("input[type=password]").value;
      f.querySelector("em").textContent = "prüfe …";
      try { await test(pw); remember(pw, f.querySelector("input[type=checkbox]").checked); onOk(pw); }
      catch (err) { f.querySelector("em").textContent = "Falsches Passwort"; }
    };
  }
  return { stored: stored, forget: forget, load: load, form: form };
})();
