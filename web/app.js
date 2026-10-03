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

  function sdChart(hist) {
    var svg = $("sdChart");
    if (!hist || hist.length < 2) { svg.innerHTML = ""; return; }
    var W = 520, H = 220, L = 30, R = 8, T = 8, B = 22, iw = W - L - R, ih = H - T - B, n = hist.length;
    var X = function (i) { return L + i * iw / (n - 1); };
    var Y = function (v) { return T + (100 - v) / 100 * ih; };
    var mono = 'font-size="10" font-family="IBM Plex Mono, monospace" fill="var(--faint)"';
    var s = "";
    [0, 25, 50, 75, 100].forEach(function (v) {
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="var(--line)" stroke-width="1"/>';
      s += '<text x="' + (L - 6) + '" y="' + (Y(v) + 4) + '" text-anchor="end" ' + mono + ">" + v + "</text>";
    });
    var months = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
    var last = -1;
    hist.forEach(function (p, i) {
      var d = new Date(p.d), m = d.getMonth();
      if (m !== last && i > 2 && i < n - 3 && m % 3 === 0) {
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

  function render(d) {
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

    var vids = d.videos || [];
    $("vMeta").textContent = (d.channels || []).length + " Kanäle";
    $("vids").innerHTML = vids.length ? vids.map(function (v) {
      var fresh = Date.now() - Date.parse(v.published) < 24 * 3600 * 1000;
      return '<li><a href="' + esc(v.url) + '" target="_blank" rel="noopener">' +
        '<img src="' + esc(v.thumb) + '" alt="" loading="lazy">' +
        '<span><span class="t">' + esc(v.title) + '</span><span class="c">' + esc(v.channel) +
        (fresh ? '<span class="new">neu</span>' : "") + "</span></span>" +
        '<span class="a">' + ago(v.published) + "</span></a></li>";
    }).join("") : '<li class="empty">Gerade keine Videos geladen.</li>';
    var links = function (arr) {
      return (arr || []).map(function (x) {
        return '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.name) + "</a>";
      }).join("");
    };
    $("channels").innerHTML = links(d.channels);
    $("mags").innerHTML = links(d.magazines);
  }

  function load() {
    fetch("data.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(render)
      .catch(function () { $("stamp").textContent = "Daten nicht erreichbar, neuer Versuch in 5 Min."; });
  }
  load();
  setInterval(load, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
})();
