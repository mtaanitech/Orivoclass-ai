/* Orivoclass chat widget.
   Embed before </body>:
   <script src="https://YOUR-HOST/widget.js" data-key="orv_..." defer></script>
   Optional attributes: data-title, data-color, data-greeting, data-position ("left" | "right") */
(function () {
  "use strict";
  var s = document.currentScript || document.querySelector('script[src*="widget.js"][data-key]');
  if (!s || !s.dataset.key) return console.error("Orivoclass: data-key is missing");
  var key = s.dataset.key;
  var api = new URL(s.src).origin + "/v1/chat";
  var title = s.dataset.title || "Orivoclass";
  var color = /^#[0-9a-f]{3,8}$/i.test(s.dataset.color || "") ? s.dataset.color : "#4f46e5";
  var greeting = s.dataset.greeting || "Hi! Ask me anything, or tell me to create an image.";
  var side = s.dataset.position === "left" ? "left" : "right";

  function mount() {
    var host = document.createElement("div");
    document.body.appendChild(host);
    var root = host.attachShadow({ mode: "open" });
    root.innerHTML =
      "<style>" +
      ":host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}" +
      "#b{position:fixed;" + side + ":18px;bottom:18px;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;font-size:24px;color:#fff;background:" + color + ";box-shadow:0 4px 14px rgba(0,0,0,.3);z-index:2147483646}" +
      "#p{position:fixed;" + side + ":18px;bottom:86px;width:min(380px,calc(100vw - 36px));height:min(560px,calc(100vh - 110px));background:#fff;color:#111;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden;z-index:2147483647}" +
      "#p[hidden]{display:none}#h{background:" + color + ";color:#fff;padding:12px 14px;font-weight:600;display:flex;justify-content:space-between;align-items:center}" +
      "#h button{background:none;border:0;color:#fff;font-size:18px;cursor:pointer}" +
      "#l{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f5f6fa}" +
      ".m{max-width:88%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word;line-height:1.45;font-size:14px}" +
      ".u{align-self:flex-end;background:" + color + ";color:#fff}.a{align-self:flex-start;background:#fff;border:1px solid #e3e5ec}" +
      ".m img{display:block;max-width:100%;border-radius:8px;margin-top:6px}.m a{color:inherit}" +
      ".src{font-size:12px;opacity:.75;margin-top:6px}" +
      ".m pre{background:#0f172a;color:#e2e8f0;border-radius:8px;padding:8px 10px;margin:6px 0;overflow-x:auto;white-space:pre;font-size:12px;line-height:1.4}.m pre code{font-family:ui-monospace,Menlo,Consolas,monospace}" +
      "#t{display:flex;gap:6px;padding:8px 10px 0;background:#fff;flex-wrap:wrap}#t:empty{display:none}" +
      "#t .th{position:relative}#t img{width:44px;height:44px;object-fit:cover;border-radius:6px}" +
      "#t .th b{position:absolute;top:-6px;right:-6px;background:#333;color:#fff;border-radius:50%;width:16px;height:16px;font-size:11px;line-height:16px;text-align:center;cursor:pointer}" +
      "form{display:flex;gap:6px;padding:10px;background:#fff;border-top:1px solid #e3e5ec;align-items:center}#t:not(:empty)+form{border-top:0}" +
      "input[type=text]{flex:1;min-width:0;padding:10px;border:1px solid #d5d8e0;border-radius:8px;font-size:14px}" +
      "form button{padding:10px 12px;border:0;border-radius:8px;background:" + color + ";color:#fff;cursor:pointer}" +
      "form button.at{background:#eef0f6;color:#333}form button:disabled{opacity:.5;cursor:default}" +
      ".pw{font-size:11px;text-align:center;color:#888;padding:0 0 6px;background:#fff}" +
      "</style><button id=b aria-label='Open chat'>💬</button>" +
      "<div id=p hidden role=dialog aria-label=Chat><div id=h><span id=ti></span><button id=x aria-label=Close>✕</button></div><div id=l></div><div id=t></div>" +
      "<form id=f><button type=button class=at id=a title='Attach image'>📎</button><input id=fi type=file accept='image/png,image/jpeg,image/webp' hidden multiple>" +
      "<input id=q type=text placeholder='Type a message...' autocomplete=off><button id=s>Send</button></form><div class=pw>Powered by Orivoclass</div></div>";
    root.getElementById("ti").textContent = title;

    var $ = function (id) { return root.getElementById(id); };
    var log = $("l"), panel = $("p"), thumbs = $("t"), history = [], pending = [], busy = false;

    function add(text, cls) {
      var d = document.createElement("div");
      d.className = "m " + cls;
      if (text) d.appendChild(document.createTextNode(text));
      log.appendChild(d); log.scrollTop = log.scrollHeight; return d;
    }
    function addImage(d, img) {
      var el = document.createElement("img");
      el.src = "data:" + img.mimeType + ";base64," + img.data; el.alt = "Generated image";
      var a = document.createElement("a"); a.href = el.src; a.download = "orivoclass.png"; a.target = "_blank"; a.rel = "noopener";
      a.appendChild(el); d.appendChild(a);
    }
    // Shows fenced code blocks as code boxes.
    function rich(el, text) {
      el.textContent = "";
      var re = /```[\w+#.-]*[ \t]*\n?([\s\S]*?)```/g, last = 0, m;
      function t(s) { s = s.replace(/^\n+|\n+$/g, ""); if (s.trim()) el.appendChild(document.createTextNode(s)); }
      while ((m = re.exec(text))) {
        t(text.slice(last, m.index));
        var pre = document.createElement("pre"), code = document.createElement("code");
        code.textContent = m[1].replace(/\n$/, ""); pre.appendChild(code); el.appendChild(pre);
        last = re.lastIndex;
      }
      t(text.slice(last));
    }
    add(greeting, "a");
    var toggle = function () { panel.hidden = !panel.hidden; if (!panel.hidden) $("q").focus(); };
    $("b").onclick = toggle; $("x").onclick = toggle;

    function renderThumbs() {
      thumbs.innerHTML = "";
      pending.forEach(function (im, i) {
        var w = document.createElement("div"); w.className = "th";
        var img = document.createElement("img"); img.src = "data:" + im.mimeType + ";base64," + im.data;
        var x = document.createElement("b"); x.textContent = "×"; x.onclick = function () { pending.splice(i, 1); renderThumbs(); };
        w.appendChild(img); w.appendChild(x); thumbs.appendChild(w);
      });
    }
    // Resize before sending so uploads stay small and fast.
    function readImage(file) {
      return new Promise(function (resolve) {
        var fr = new FileReader();
        fr.onload = function () {
          var img = new Image();
          img.onload = function () {
            var max = 1280, sc = Math.min(1, max / Math.max(img.width, img.height));
            var c = document.createElement("canvas"); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            resolve({ mimeType: "image/jpeg", data: c.toDataURL("image/jpeg", 0.85).split(",")[1] });
          };
          img.onerror = function () { resolve(null); };
          img.src = fr.result;
        };
        fr.onerror = function () { resolve(null); };
        fr.readAsDataURL(file);
      });
    }
    $("a").onclick = function () { $("fi").click(); };
    $("fi").onchange = function () {
      var files = Array.prototype.slice.call($("fi").files, 0, 4 - pending.length);
      Promise.all(files.map(readImage)).then(function (r) {
        r.forEach(function (im) { if (im && pending.length < 4) pending.push(im); });
        renderThumbs(); $("fi").value = "";
      });
    };

    $("f").onsubmit = function (e) {
      e.preventDefault();
      if (busy) return;
      var text = $("q").value.trim(), imgs = pending.slice();
      if (!text && !imgs.length) return;
      busy = true; $("s").disabled = true;
      $("q").value = ""; pending = []; renderThumbs();
      var ub = add(text, "u");
      imgs.forEach(function (im) { addImage(ub, im); });
      history.push({ role: "user", text: text, images: imgs });
      var reply = add("...", "a");
      // Only send images from the latest turn to keep requests small.
      var payload = history.slice(-20).map(function (m, i, arr) {
        return { role: m.role, text: m.text, images: i === arr.length - 1 ? m.images : [] };
      });
      fetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({ messages: payload }),
      })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "Request failed"); return d; }); })
        .then(function (d) {
          rich(reply, d.reply || "");
          (d.images || []).forEach(function (im) { addImage(reply, im); });
          if (d.sources && d.sources.length) {
            var sd = document.createElement("div"); sd.className = "src"; sd.appendChild(document.createTextNode("Sources: "));
            d.sources.slice(0, 3).forEach(function (src, i) {
              if (i) sd.appendChild(document.createTextNode(", "));
              var a = document.createElement("a"); a.href = src.uri; a.target = "_blank"; a.rel = "noopener"; a.textContent = src.title; sd.appendChild(a);
            });
            reply.appendChild(sd);
          }
          history.push({ role: "model", text: d.reply || "", images: [] });
        })
        .catch(function (err) { reply.textContent = "Error: " + err.message; history.pop(); })
        .then(function () { busy = false; $("s").disabled = false; log.scrollTop = log.scrollHeight; });
    };
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
