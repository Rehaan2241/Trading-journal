// Pictures page: one card per trade that has at least one chart screenshot
// attached, grouped/labeled by timeframe (1m/3m/5m/15m/1h/4h). Clicking a
// card opens a lightbox (not a new page) with left/right arrows to flip
// through every screenshot saved for that trade.

let picturesCache = []; // trades with screenshots, most recent first
let picturesFilters = {};
let lightboxTrade = null;
let lightboxIndex = 0;

async function initPicturesPage() {
  renderFiltersBar("filters-bar", (filters) => {
    picturesFilters = filters;
    loadPictures();
  });

  document.getElementById("lightbox-close").addEventListener("click", closeLightbox);
  document.getElementById("picture-lightbox").addEventListener("click", (e) => {
    if (e.target.id === "picture-lightbox") closeLightbox();
  });
  document.getElementById("lightbox-prev").addEventListener("click", () => stepLightbox(-1));
  document.getElementById("lightbox-next").addEventListener("click", () => stepLightbox(1));
  document.addEventListener("keydown", (e) => {
    const open = document.getElementById("picture-lightbox").style.display === "flex";
    if (!open) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") stepLightbox(-1);
    if (e.key === "ArrowRight") stepLightbox(1);
  });

  await loadPictures();
  await openFromQueryString();
}

// Lets other pages link straight into a specific trade + timeframe, e.g.
// `pictures.html?trade=42&tf=5m` from a screenshot thumbnail in the shared
// Trade Detail modal (Dashboard/Trades/Calendar/Challenges) or the Trades
// table. Falls back to fetching the trade directly if the current filters
// on this page happen to exclude it.
async function openFromQueryString() {
  const params = new URLSearchParams(window.location.search);
  const tradeId = params.get("trade");
  if (!tradeId) return;
  const tf = params.get("tf") || null;

  let trade = picturesCache.find((t) => String(t.id) === String(tradeId));
  if (!trade) {
    try {
      trade = await Api.getTrade(tradeId);
    } catch (e) {
      console.error("Couldn't load linked trade for Pictures deep link", e);
      return;
    }
  }
  openLightboxForTrade(trade, tf);
  // Clean the URL so refreshing or hitting back doesn't reopen the same
  // lightbox every time.
  window.history.replaceState({}, "", "pictures.html");
}

async function loadPictures() {
  const grid = document.getElementById("picture-grid");
  grid.innerHTML = `<div class="empty-state">Loading pictures…</div>`;
  try {
    const res = await Api.getTrades(picturesFilters);
    picturesCache = (res.items || [])
      .filter((t) => t.screenshot_urls && t.screenshot_urls.length)
      .sort((a, b) => (a.trade_date < b.trade_date ? 1 : -1));
    renderPictureGrid();
  } catch (e) {
    grid.innerHTML = `<div class="empty-state">Couldn't load pictures: ${escapeHtml(e.message)}</div>`;
  }
}

function renderPictureGrid() {
  const grid = document.getElementById("picture-grid");
  if (!picturesCache.length) {
    grid.innerHTML = `<div class="empty-state">No trades with chart screenshots yet — attach some from the Trades page.</div>`;
    return;
  }

  grid.innerHTML = picturesCache
    .map((t, idx) => {
      const shots = tradeScreenshotsOrdered(t);
      const cover = shots[0]; // 1m first if present, else earliest timeframe attached
      return `
        <div class="picture-card" data-idx="${idx}">
          <div class="picture-card-img-wrap">
            <img class="picture-card-img" src="${Api.fileUrl(cover.url)}" alt="${escapeHtml(t.pair)} ${cover.tf || ""} screenshot" />
            ${shots.length > 1 ? `<span class="picture-card-count">${shots.length} pics</span>` : ""}
          </div>
          <div class="picture-card-body">
            <div class="picture-card-top">
              <span class="picture-card-pair">${escapeHtml(t.pair)}</span>
              <span class="badge ${resultBadgeClass(t.result)}">${t.result}</span>
            </div>
            <div class="picture-card-meta">
              <span>${t.trade_date}</span>
              <span>${cover.tf || "unlabeled"}</span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  grid.querySelectorAll(".picture-card").forEach((card) => {
    card.addEventListener("click", () => openLightbox(Number(card.dataset.idx)));
  });
}

function openLightbox(idx) {
  openLightboxForTrade(picturesCache[idx], null);
}

// tf === null opens on the trade's first available screenshot (same as
// clicking the card); a specific tf jumps straight to that one if the
// trade has it.
function openLightboxForTrade(trade, tf) {
  if (!trade) return;
  lightboxTrade = trade;
  lightboxIndex = 0;
  if (tf) {
    const shots = tradeScreenshotsOrdered(trade);
    const found = shots.findIndex((s) => s.tf === tf);
    if (found >= 0) lightboxIndex = found;
  }
  document.getElementById("picture-lightbox").style.display = "flex";
  renderLightbox();
}

function closeLightbox() {
  document.getElementById("picture-lightbox").style.display = "none";
  lightboxTrade = null;
}

function stepLightbox(dir) {
  if (!lightboxTrade) return;
  const shots = tradeScreenshotsOrdered(lightboxTrade);
  if (!shots.length) return;
  lightboxIndex = (lightboxIndex + dir + shots.length) % shots.length;
  renderLightbox();
}

function renderLightbox() {
  if (!lightboxTrade) return;
  const shots = tradeScreenshotsOrdered(lightboxTrade);
  const shot = shots[lightboxIndex];

  document.getElementById("lightbox-title").innerHTML = `
    ${escapeHtml(lightboxTrade.pair)}
    <span class="badge ${positionBadgeClass(lightboxTrade.position)}">${lightboxTrade.position}</span>
    <span class="badge ${resultBadgeClass(lightboxTrade.result)}">${lightboxTrade.result}</span>
  `;
  document.getElementById("lightbox-img").src = Api.fileUrl(shot.url);
  document.getElementById("lightbox-img").alt = `${shot.tf || "Screenshot"}`;
  document.getElementById("lightbox-caption").innerText =
    `${lightboxTrade.trade_date}  ·  ${fmtMoney(lightboxTrade.pnl)}  ·  ${shot.tf ? shot.tf + " timeframe" : "Untagged screenshot"} (${lightboxIndex + 1}/${shots.length})`;

  // Only show arrows when there's actually more than one to flip through.
  const showArrows = shots.length > 1;
  document.getElementById("lightbox-prev").style.display = showArrows ? "flex" : "none";
  document.getElementById("lightbox-next").style.display = showArrows ? "flex" : "none";

  document.getElementById("lightbox-tf-strip").innerHTML = shots
    .map(
      (s, i) =>
        `<span class="lightbox-tf-chip ${i === lightboxIndex ? "active" : ""}" data-i="${i}">${s.tf || "unlabeled"}</span>`
    )
    .join("");
  document.querySelectorAll(".lightbox-tf-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      lightboxIndex = Number(chip.dataset.i);
      renderLightbox();
    });
  });
}
