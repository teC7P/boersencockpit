(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var nf = function (d) { return new Intl.NumberFormat("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var minus = function (s) { return s.replace("-", "−"); };

  function ago(iso) {
    var t = Date.parse(iso);
    if (!t) return "";
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 60) return "vor " + Math.max(1, m) + " Min.";
    var h = Math.round(m / 60);
    if (h < 24) return "vor " + h + " Std.";
    var d = Math.round(h / 24);
    return "vor " + d + (d === 1 ? " Tag" : " Tagen");
  }

  function spark(data, good) {
    if (!data || data.length < 2) return "<svg aria-hidden='true'></svg>";
    var w = 120, h = 22, min = Math.min.apply(null, data), max = Math.max.apply(null, data), r = max - min || 1;
    var pts = data.map(function (v, i) { return [i * (w - 4) / (data.length - 1) + 2, h - 2 - (v - min) / r * (h - 6)]; });
    var line = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ");
    var last = pts[pts.length - 1];
    var col = good === null ? "var(--muted)" : good ? "var(--up)" : "var(--down)";
    return '<svg viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' + line + " L" + last[0].toFixed(1) + " " + h + " L2 " + h + ' Z" fill="' + col + '" fill-opacity=".12"/>' +
      '<path d="' + line + '" fill="none" stroke="' + col + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2" fill="' + col + '"/></svg>';
  }

  function tile(t) {
    if (t.missing) {
      return '<div class="tile missing"><span class="n">' + esc(t.name) + '</span><span class="v">–</span>' +
        '<span></span><span class="d">keine Daten</span></div>';
    }
    var unit = t.unit === "%" ? " %" : t.unit === "$" ? " $" : "";
    var val = nf(t.dec).format(t.value) + unit;
    var diff = t.value - t.prev, chg, cls;
    if (t.chg === "label") {
      chg = esc(t.label || "");
      cls = diff >= 0 ? "up" : "down";
    } else if (t.chg === "bp") {
      var bp = Math.round(diff * 100);
      chg = minus((bp > 0 ? "+" : "") + bp + " Bp");
      cls = bp === 0 ? "" : (bp > 0) !== !!t.invert ? "up" : "down";
    } else {
      var pct = t.prev ? diff / t.prev * 100 : 0;
      chg = minus((pct > 0 ? "+" : "") + nf(1).format(pct) + " %");
      cls = Math.abs(pct) < 0.05 ? "" : (pct > 0) !== !!t.invert ? "up" : "down";
    }
    var trendGood = t.spark && t.spark.length > 1 ? (t.spark[t.spark.length - 1] >= t.spark[0]) !== !!t.invert : null;
    var ma = typeof t.aboveMa200 === "boolean"
      ? '<span class="ma ' + (t.aboveMa200 ? "up" : "down") + '" title="' + (t.aboveMa200 ? "über" : "unter") +
        ' der 200-Tage-Linie">' + (t.aboveMa200 ? "▲" : "▼") + " 200T</span>" : "";
    var old = t.stale ? '<span class="old-tag" title="Quelle gerade nicht erreichbar, letzter Wert">alt</span>' : "";
    var title = (t.source || "") + (t.asOf ? " · Stand " + new Date(t.asOf).toLocaleString("de-DE") : "");
    return '<div class="tile' + (t.stale ? " stale" : "") + '" title="' + esc(title) + '">' +
      '<span class="n">' + esc(t.name) + ma + old + '</span><span class="v">' + val + "</span>" +
      "<span>" + spark(t.spark, trendGood) + '</span><span class="d ' + cls + '">' + chg + "</span></div>";
  }

  var sdHist = null;
  function sdChart(hist) {
    var svg = $("sdChart");
    sdHist = hist;
    if (!hist || hist.length < 2) { svg.innerHTML = ""; return; }
    // Breite wie das Panel (volle Seitenbreite), Höhe fest; auf schmalen Geräten skaliert der 520er-Rahmen
    var W = Math.max(520, Math.round(svg.clientWidth || 520)), H = 220;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    var W0 = W, L = 30, R = 8, T = 8, B = 22, iw = W - L - R, ih = H - T - B, n = hist.length;
    var X = function (i) { return L + i * iw / (n - 1); };
    var Y = function (v) { return T + (100 - v) / 100 * ih; };
    var mono = 'font-size="10" font-family="-apple-system, BlinkMacSystemFont, Helvetica Neue, Arial, sans-serif" fill="var(--faint)"';
    var s = "";
    [0, 25, 50, 75, 100].forEach(function (v) {
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="var(--line)" stroke-width="1"/>';
      s += '<text x="' + (L - 6) + '" y="' + (Y(v) + 4) + '" text-anchor="end" ' + mono + ">" + v + "</text>";
    });
    var months = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
    var last = -1;
    hist.forEach(function (p, i) {
      var d = new Date(p.d), m = d.getMonth();
      if (m !== last && i > 2 && i < n - 3 && (W0 >= 800 || m % 3 === 0)) {
        s += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" ' + mono + ">" + months[m] + "</text>";
      }
      last = m;
    });
    var path = function (k) {
      return hist.map(function (p, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(p[k]).toFixed(1); }).join(" ");
    };
    s += '<path d="' + path("s") + '" fill="none" stroke="var(--smart)" stroke-width="2"/>';
    s += '<path d="' + path("u") + '" fill="none" stroke="var(--dumb)" stroke-width="2"/>';
    var e = hist[n - 1];
    s += '<circle cx="' + X(n - 1) + '" cy="' + Y(e.s) + '" r="3.5" fill="var(--smart)"/>';
    s += '<circle cx="' + X(n - 1) + '" cy="' + Y(e.u) + '" r="3.5" fill="var(--dumb)"/>';
    svg.innerHTML = s;
  }

  var resizeT;
  window.addEventListener("resize", function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { if (sdHist) sdChart(sdHist); }, 150);
  });

  var current = null;  // Zeitstempel der angezeigten Daten (für den Update-Knopf)

  function render(d) {
    current = d.updated;
    var upd = Date.parse(d.updated);
    var stamp = $("stamp");
    stamp.textContent = "Stand " + new Date(upd).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
    stamp.classList.toggle("old", Date.now() - upd > 3 * 3600 * 1000);

    $("verdictLabel").textContent = "Marktlage: " + d.verdict.label;
    $("verdictText").textContent = d.verdict.text;
    $("chips").innerHTML = d.verdict.signals.map(function (s) {
      return '<span class="chip ' + s.state + '"><i></i>' + esc(s.text) + "</span>";
    }).join("");

    $("groups").innerHTML = d.groups.map(function (g) {
      return '<div class="grp"><h3>' + esc(g.name) + "</h3>" + g.items.map(tile).join("") + "</div>";
    }).join("");

    var sd = d.smartDumb;
    if (sd) {
      $("sdSmart").textContent = sd.smart;
      $("sdDumb").textContent = sd.dumb;
      $("sdSpread").textContent = minus((sd.spread > 0 ? "+" : "") + sd.spread);
      $("sdSpread").style.color = sd.state === "g" ? "var(--up)" : sd.state === "r" ? "var(--down)" : "";
      $("sdLabel").textContent = "Abstand · " + sd.label;
      $("sdMeta").textContent = "S&P 500 · CFTC · Stand " + new Date(sd.asOf).toLocaleDateString("de-DE") + (sd.stale ? " · alt" : "");
      sdChart(sd.history);
    } else {
      $("sdMeta").textContent = "gerade keine Daten";
    }

    // Je Kanal das neueste Video, nach Sprache getrennt und alphabetisch nach Kanalname
    var latest = d.latest || [];
    $("vMeta").textContent = latest.length + " Kanäle";
    var byName = function (a, b) { return a.channel.localeCompare(b.channel, "de", { sensitivity: "base" }); };
    var vrow = function (v) {
      if (!v.url) {
        return '<li><a href="' + esc(v.channelUrl) + '" target="_blank" rel="noopener"><span class="noimg"></span>' +
          '<span><span class="c">' + esc(v.channel) + '</span><span class="t empty">gerade kein Video geladen</span></span></a></li>';
      }
      var fresh = Date.now() - Date.parse(v.published) < 24 * 3600 * 1000;
      return '<li><a href="' + esc(v.url) + '" target="_blank" rel="noopener">' +
        '<img src="' + esc(v.thumb) + '" alt="" loading="lazy">' +
        '<span><span class="c">' + esc(v.channel) + (fresh ? '<span class="new">neu</span>' : "") + "</span>" +
        '<span class="t">' + esc(v.title) + "</span></span>" +
        '<span class="a">' + ago(v.published) + "</span></a></li>";
    };
    ["de", "en"].forEach(function (lang) {
      var rows = latest.filter(function (v) { return (v.lang || "de") === lang; }).sort(byName);
      $(lang === "de" ? "ytDe" : "ytEn").innerHTML = rows.length ? rows.map(vrow).join("")
        : '<li class="empty">Daten kommen mit der nächsten Aktualisierung.</li>';
    });
    var links = function (arr) {
      return (arr || []).map(function (x) {
        return '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.name) + "</a>";
      }).join("");
    };
    $("mags").innerHTML = links(d.magazines);
    $("news").innerHTML = (d.news || []).map(function (x) {
      return '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener"><b>' + esc(x.name) + "</b>" +
        '<span>' + esc(x.note || "") + '</span><i>' + esc((x.lang || "").toUpperCase()) + "</i></a></li>";
    }).join("") || '<li class="empty">Daten kommen mit der nächsten Aktualisierung.</li>';
  }

  // Video-Analyse: kommt verschlüsselt vom lokalen Report-Tool auf dem Mac (va-*.enc.json)
  // Nur Stand und Links: gelesen wird immer der ganze Report. "neu" bis der Report einmal geöffnet wurde.
  function seenReport(set) {
    try { if (set) localStorage.setItem("bc-seen-report", set); return localStorage.getItem("bc-seen-report"); }
    catch (e) { return null; }
  }
  function renderVA(r) {
    var created = Date.parse(r.created);
    var old = Date.now() - created > 36 * 3600 * 1000;
    var fresh = seenReport() !== r.report;
    $("vaForm").innerHTML = "";
    $("vaMeta").innerHTML = esc(new Date(created).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })) +
      " · " + r.videos + " Videos" + (fresh ? '<span class="new">neu</span>' : "") + (old ? ' <span class="old-tag">alt</span>' : "");
    // gleicher Tab, damit das Passwort aus dieser Sitzung weiter gilt
    $("vaLinks").innerHTML = '<a class="main" id="vaOpen" href="report.html?r=' + esc(r.report.replace(".html", "")) + '">Report öffnen</a>' +
      '<a href="report.html">Archiv</a><a href="#" id="vaLock">🔒 Sperren</a>';
    $("vaOpen").onclick = function () { seenReport(r.report); };
    $("vaLock").onclick = function (e) { e.preventDefault(); BCLock.forget(); location.reload(); };
  }

  // Reports liegen verschlüsselt auf GitHub; ohne Passwort zeigt der Kasten nur das Schloss
  function loadVA() {
    var pw = window.BCLock && BCLock.stored();
    fetch("va-latest.enc.json", { method: "HEAD", cache: "no-store" }).then(function (r) {
      if (!r.ok) { $("va").hidden = true; return; }
      $("va").hidden = false;
      var unlock = function (p) { return BCLock.load("va-latest.enc.json", p).then(function (t) { renderVA(JSON.parse(t)); }); };
      var ask = function () {
        $("vaMeta").textContent = ""; $("vaLinks").innerHTML = "";
        BCLock.form($("vaForm"), unlock, function () {});
      };
      // kein forget: dasselbe Passwort entsperrt auch das Cockpit
      if (pw) unlock(pw).catch(ask); else ask();
    }).catch(function () { $("va").hidden = true; });
  }

  function unreachable() { $("stamp").textContent = "Daten nicht erreichbar, neuer Versuch in 5 Min."; }

  // Ist ein Cockpit-Passwort gesetzt, liegen die Daten nur verschlüsselt vor (data.enc.json)
  function openSealed(pw) {
    return BCLock.load("data.enc.json", pw).then(function (t) {
      document.body.classList.remove("locked");
      $("gate").hidden = true;
      render(JSON.parse(t));
      showUpdate();
    });
  }

  // Update-Knopf: startet den GitHub-Workflow sofort. Der dafür nötige Token (darf nur Workflows
  // dieses Repos starten) liegt mit dem Cockpit-Passwort verschlüsselt in trigger.enc.json.
  // Beim Öffnen automatisch anstoßen, wenn die Daten älter als 20 Minuten sind
  // (höchstens alle 10 Minuten, damit mehrere offene Tabs/Geräte nicht ständig Läufe starten)
  var AUTO_AGE = 20 * 60 * 1000, AUTO_GAP = 10 * 60 * 1000;
  function lastTrigger(set) {
    try { if (set) localStorage.setItem("bc-last-trigger", String(Date.now())); return +localStorage.getItem("bc-last-trigger") || 0; }
    catch (e) { return 0; }
  }

  function showUpdate() {
    fetch("trigger.enc.json", { method: "HEAD", cache: "no-store" }).then(function (r) {
      $("upd").hidden = !r.ok;
      if (r.ok && current && Date.now() - Date.parse(current) > AUTO_AGE && Date.now() - lastTrigger() > AUTO_GAP) updateNow();
    });
  }

  function updateNow() {
    var btn = $("upd"), pw = BCLock.stored();
    var say = function (t, busy) { btn.textContent = t; btn.disabled = !!busy; };
    if (!pw) return;
    lastTrigger(true);
    var owner = location.hostname.split(".")[0], repo = location.pathname.split("/")[1];
    say("⏳ startet …", true);
    BCLock.load("trigger.enc.json", pw).then(function (token) {
      return fetch("https://api.github.com/repos/" + owner + "/" + repo + "/actions/workflows/update.yml/dispatches", {
        method: "POST",
        headers: { Authorization: "Bearer " + token.trim(), Accept: "application/vnd.github+json" },
        body: JSON.stringify({ ref: "main" })
      });
    }).then(function (r) {
      if (r.status !== 204) throw new Error(r.status === 401 ? "Token ungültig oder abgelaufen" : "GitHub-Fehler " + r.status);
      say("⏳ wird aktualisiert …", true);
      var before = current, tries = 0;
      var check = function () {
        BCLock.load("data.enc.json", pw).then(function (t) {
          var d = JSON.parse(t);
          if (d.updated !== before) { render(d); loadVA(pw); say("✓ aktualisiert", true); setTimeout(function () { say("🔄 Update"); }, 8000); }
          else if (++tries < 30) setTimeout(check, 15000);
          else say("⚠ dauert länger – später neu laden");
        }).catch(function () { if (++tries < 30) setTimeout(check, 15000); });
      };
      setTimeout(check, 60000);  // Lauf + Veröffentlichung dauern meist 1,5–3 Minuten
    }).catch(function (e) { say("⚠ " + e.message); setTimeout(function () { say("🔄 Update"); }, 8000); });
  }
  $("upd").onclick = updateNow;

  function gate() {
    document.body.classList.add("locked");
    $("gate").hidden = false;
    $("stamp").textContent = "gesperrt";
    BCLock.form($("gate"), openSealed, loadVA, "Börsencockpit ist passwortgeschützt");
  }

  function load() {
    fetch("data.enc.json", { method: "HEAD", cache: "no-store" }).then(function (h) {
      if (!h.ok) {
        return fetch("data.json?t=" + Date.now(), { cache: "no-store" })
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
          .then(function (d) { render(d); loadVA(); });
      }
      var pw = BCLock.stored();
      if (!pw) return gate();
      return openSealed(pw).then(loadVA, function (e) {
        if (e.message !== "Falsches Passwort") throw e;
        BCLock.forget();
        gate();
      });
    }).catch(unreachable);
  }
  load();
  setInterval(function () { if (!document.body.classList.contains("locked")) load(); }, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !document.body.classList.contains("locked")) load();
  });
})();
