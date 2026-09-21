// =====================================================
// TICKET TO RIDE — SCORE TRACKER
// app.js — All application logic
//
// Architecture:
//   - Firebase Firestore stores config and game results
//   - All screens live in index.html; JS shows/hides them
//   - state{} is the single source of truth in memory
//   - listenToGames() keeps state.games in sync in real time
// =====================================================

import { initializeApp }       from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import {
    getFirestore,
    doc, getDoc, setDoc, deleteDoc,
    collection, addDoc, getDocs,
    query, orderBy, onSnapshot,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import { bucketKeyFor, findGroupByBucketKey, groupDisplayName } from "./group-utils.js";

// --- Firebase config (dedicated project) ---
// TODO: replace with the SA family's own Firebase project config
// (Project settings > General > Your apps > web app). This is a
// placeholder, not a real project — the app won't connect until
// this is filled in.
const firebaseConfig = {
    apiKey:            "REPLACE_ME",
    authDomain:        "REPLACE_ME.firebaseapp.com",
    projectId:         "REPLACE_ME",
    storageBucket:     "REPLACE_ME.firebasestorage.app",
    messagingSenderId: "REPLACE_ME",
    appId:             "REPLACE_ME"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth        = getAuth(firebaseApp);
const db          = getFirestore(firebaseApp);

// Firestore collection names — completely separate from HRB Cleaning
const COL_CONFIG = "ttr_config";   // single doc: "config"
const COL_GAMES  = "ttr_games";    // one doc per game
const COL_GROUPS = "ttr_groups";   // one doc per player group per season (holds the group's goal)

// Key used in sessionStorage to remember a correct PIN entry.
// sessionStorage survives page navigation (e.g. map view and back)
// but is cleared when the browser tab is closed.
const PIN_SESSION_KEY = "ttr_pin_ok";

// Pool of train-themed names randomly assigned to each saved game,
// so history entries read like "Kevin won 'The Midnight Express'"
// instead of just a bare date.
const GAME_NAMES = [
    "Die Middernag Ekspres", "Die Groot Roete Roof", "Ysterperd Gambiet",
    "Die Laaste Spyker", "Trokwa Bonanza", "Die Fluitjie-stop Naeljaag",
    "Tonnelvisie", "Die Kaartjie Roof", "Spoorbaron se Wraak",
    "Die Groot Aansluiting", "Staalwiele Naeljaag", "Die Nag Ekspres",
    "Die Vragwaansin", "Depot Tweestryd", "Die Lang Sleep",
    "Wisselspoor Uitdaging", "Die Goue Spyker Gambiet", "Die Skilderagtige Roete Gejaag",
    "Almal-Aan-Boord Lokval", "Die Stertwa Terugslag", "Die Slaapwa Skuifel",
    "Trans-Kontinentale Stoeiery", "Die Steenkoolwa Botsing", "Seinhuisie Konfrontasie",
    "Die Platform Konfrontasie", "Aansluiting Skrik", "Die Rooster Deurmekaarspul",
    "Ontsporte Ambisies", "Die Silwer Spoor Uitdaging", "Spoorrekord",
    "Die Dwarslands Botsing", "Volstoom Vorentoe", "Die Taklyn Bakleiery",
    "Koppeling Chaos", "Die Eindpunt Deurmekaarspul", "Nagtrein Senuwees",
    "Die Lokomosie Tweestryd", "Spore en Mededingers", "Die Grensoorgang",
    "Fluitjie Geblaas"
];

function pickGameName() {
    return GAME_NAMES[Math.floor(Math.random() * GAME_NAMES.length)];
}

// Returns the name(s) of the top scorer(s) in a single game, joined
// with " & " in the (rare) case of a tie.
function gameWinner(game) {
    const entries = Object.entries(game.scores);
    const top     = Math.max(...entries.map(([, pts]) => pts));
    return entries.filter(([, pts]) => pts === top).map(([name]) => name).join(" & ");
}

// =====================================================
// APP STATE — single source of truth
// =====================================================
const state = {
    config:        null,   // { pin, goal (default for new groups), players[], season }
    games:         [],     // all game docs from Firestore for current season
    groups:        [],     // all group docs (goal per player group) for current season
    authenticated: false
};

// =====================================================
// STARTUP
// Called once when the page loads
// =====================================================
async function init() {
    showScreen("screen-loading");

    // Anonymous sign-in is required to read/write Firestore
    try {
        await signInAnonymously(auth);
    } catch (err) {
        alert("Kon nie aan die databasis koppel nie. Gaan asseblief jou internetverbinding na en probeer weer.");
        return;
    }

    // Check whether first-time setup has been completed
    const configSnap = await getDoc(doc(db, COL_CONFIG, "config"));

    if (!configSnap.exists()) {
        // No config found — show setup wizard
        showScreen("screen-setup");
        renderSetupPlayers();
    } else {
        state.config = configSnap.data();

        // Skip the PIN screen if it was already entered correctly
        // in this browser session (e.g. coming back from the map view)
        if (sessionStorage.getItem(PIN_SESSION_KEY) === String(state.config.pin)) {
            state.authenticated = true;
            enterMainApp();
        } else {
            showScreen("screen-pin");
            setupPinInputs();
        }
    }
}

// =====================================================
// SCREEN MANAGEMENT
// Only one screen visible at a time
// =====================================================
function showScreen(id) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById(id).classList.add("active");
}

// =====================================================
// PIN SCREEN
// =====================================================

// Wires up the 4 digit inputs: auto-advance, backspace, auto-submit
function setupPinInputs() {
    const digits = [...document.querySelectorAll(".pin-digit")];

    digits.forEach((input, i) => {
        input.addEventListener("focus", () => { input.value = ""; });

        input.addEventListener("input", () => {
            // Keep only the last character typed
            if (input.value.length > 1) input.value = input.value.slice(-1);
            // Advance to next box
            if (input.value && i < digits.length - 1) digits[i + 1].focus();
            // Auto-submit when the last box is filled
            if (i === digits.length - 1 && input.value) checkPin();
        });

        input.addEventListener("keydown", e => {
            // Backspace on empty box goes back to previous
            if (e.key === "Backspace" && !input.value && i > 0) digits[i - 1].focus();
        });
    });

    digits[0].focus();
}

// Compares entered PIN against stored value
function checkPin() {
    const digits  = [...document.querySelectorAll(".pin-digit")];
    const entered = digits.map(d => d.value).join("");
    const error   = document.getElementById("pin-error");

    if (entered === String(state.config.pin)) {
        state.authenticated = true;
        // Remember the PIN for this browser session so navigating
        // away (e.g. to the map) and back doesn't ask for it again.
        // Storing the PIN value (not just a flag) means a PIN change
        // in Settings automatically invalidates old sessions.
        sessionStorage.setItem(PIN_SESSION_KEY, entered);
        error.classList.add("hidden");
        enterMainApp();
    } else {
        error.classList.remove("hidden");
        digits.forEach(d => { d.value = ""; });
        digits[0].focus();
    }
}

// =====================================================
// MAIN APP
// =====================================================

function enterMainApp() {
    showScreen("screen-main");
    updateGoalDisplay();
    listenToGroups();  // real-time listener for per-group goals
    listenToGames();   // real-time listener for game results
}

// Updates the default goal number shown in the banner
// (this is the goal offered to NEW groups; each group has its own)
function updateGoalDisplay() {
    document.getElementById("goal-display").textContent =
        Number(state.config.goal).toLocaleString() + " pte";
}

// =====================================================
// FIRST-TIME SETUP
// =====================================================

let setupPlayers = [];

// Renders the player tag chips in the setup form
function renderSetupPlayers() {
    document.getElementById("setup-players-list").innerHTML =
        setupPlayers.map((p, i) =>
            `<span class="player-tag">${p}
             <button onclick="removeSetupPlayer(${i})" aria-label="Verwyder ${p}">×</button>
             </span>`
        ).join("");
}

function addSetupPlayer() {
    const input = document.getElementById("setup-player-input");
    const name  = input.value.trim();
    if (!name) return;
    if (setupPlayers.includes(name))  { alert("Daardie speler is reeds op die lys."); return; }
    setupPlayers.push(name);
    input.value = "";
    renderSetupPlayers();
}

function removeSetupPlayer(index) {
    setupPlayers.splice(index, 1);
    renderSetupPlayers();
}

// Validates setup form and saves config to Firestore
async function saveSetup() {
    const pin  = document.getElementById("setup-pin").value.trim();
    const goal = parseInt(document.getElementById("setup-goal").value) || 1000;

    if (!pin || pin.length !== 4 || isNaN(pin))  { alert("Voer asseblief 'n 4-syfer PIN in."); return; }
    if (setupPlayers.length < 2)                  { alert("Voeg asseblief ten minste 2 spelers by."); return; }

    const config = { pin, goal, players: setupPlayers, season: 0 };
    await setDoc(doc(db, COL_CONFIG, "config"), config);

    state.config        = config;
    state.authenticated = true;
    enterMainApp();
}

// =====================================================
// GROUP GOALS
// Each player group has its own season goal, stored as
// one document per group per season in COL_GROUPS.
//
// Bucketing (bucketKeyFor / findGroupByBucketKey / groupDisplayName)
// lives in group-utils.js, shared with map-firebase.js, so the
// scoreboard and the season map can't drift apart on how a group is
// identified — that drift is exactly how the map ended up merging
// two same-roster groups together.
// =====================================================

// All existing groups whose player list matches this exact groupKey.
// Can return more than one once groups can share a roster.
function groupsForKey(groupKey) {
    return state.groups.filter(g => g.groupKey === groupKey);
}

// Thin wrapper: the shared helper takes a group list explicitly,
// app.js always means state.groups.
function groupByBucketKey(bucketKey) {
    return findGroupByBucketKey(state.groups, bucketKey);
}

// True once the first groups snapshot has arrived.
// Prevents checkForWinners() running against fallback goals
// before the real per-group goals have loaded.
let groupsLoaded = false;

// Real-time listener that keeps state.groups in sync
function listenToGroups() {
    onSnapshot(collection(db, COL_GROUPS), snap => {
        const currentSeason = state.config.season ?? 0;
        state.groups = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(g => (g.season ?? 0) === currentSeason);
        groupsLoaded = true;
        renderGroups();
    });
}

// =====================================================
// ADD GAME MODAL
// =====================================================

// When "Add Result" is clicked on a specific group's card, the modal
// opens pre-ticked for that group's players and locked to that exact
// group — no "which group?" picker, since we already know which one.
// If the player selection is then edited away from this exact roster,
// updateGroupSection() falls back to the normal picker/new-group flow.
let lockedGroupId  = null;
let lockedGroupKey = null;

// lockGroupId + preselect are only passed when opened via a group
// card's "Add Result" button (see addResultToGroup below).
function openAddGame({ lockGroupId = null, preselect = [] } = {}) {
    const modal = document.getElementById("modal-add-game");
    modal.classList.remove("hidden");

    // Default to today's date
    document.getElementById("game-date").value = todayISO();

    // Render one checkbox per player, pre-ticking any from preselect
    document.getElementById("game-player-checkboxes").innerHTML =
        state.config.players.map(p =>
            `<div class="player-check-item">
               <input type="checkbox" id="chk-${p}" value="${p}" onchange="updateScoreInputs()"
                      ${preselect.includes(p) ? "checked" : ""}>
               <label for="chk-${p}">${p}</label>
             </div>`
        ).join("");

    lockedGroupId  = lockGroupId;
    lockedGroupKey = lockGroupId ? [...preselect].sort().join(",") : null;

    // Builds score rows for any pre-ticked players and the group
    // section (picker/new-group fields, or nothing if locked)
    updateScoreInputs();
}

// Called from the "Add Result" button on an existing group's card.
function addResultToGroup(bucketKey) {
    const groupGames = state.games.filter(g => bucketKeyFor(g) === bucketKey);
    if (groupGames.length === 0) return;

    const players = groupGames[0].groupKey.split(",");
    const group   = groupByBucketKey(bucketKey);

    // Every group should have a doc (it's created alongside its first
    // game), but fall back to the normal unlocked flow just in case.
    openAddGame({ lockGroupId: group ? group.id : null, preselect: players });
}

function closeAddGame() {
    document.getElementById("modal-add-game").classList.add("hidden");
    lockedGroupId  = null;
    lockedGroupKey = null;
}

// Renders a score input for each checked player
function updateScoreInputs() {
    const checked   = checkedPlayers();
    const container = document.getElementById("game-score-inputs");

    if (checked.length === 0) { container.innerHTML = ""; }
    else {
        container.innerHTML =
            `<p class="score-section-label">Voer finale tellings in</p>` +
            checked.map(p =>
                `<div class="score-row">
                   <label for="score-${p}">${p}</label>
                   <input type="number" id="score-${p}" placeholder="0" min="0" inputmode="numeric">
                 </div>`
            ).join("");
    }

    updateGroupSection();
}

// Decides what to show below the score inputs, based on whether the
// checked players match any existing group(s):
//   - locked to a group (opened via its card's "Add Result" button)
//     AND the roster is unchanged -> nothing to show, it's unambiguous
//   - no matches   -> this MUST be a new group: show name + goal fields
//   - 1+ matches   -> ask "which group is this for?", with a
//                     "start a new group" option in the same list
function updateGroupSection() {
    const checked = checkedPlayers();
    const section = document.getElementById("game-goal-section");

    if (checked.length < 2) {
        section.innerHTML = "";
        section.classList.add("hidden");
        return;
    }

    const groupKey = [...checked].sort().join(",");

    if (lockedGroupId && groupKey === lockedGroupKey) {
        section.innerHTML = "";
        section.classList.add("hidden");
        return;
    }

    const matches  = groupsForKey(groupKey);

    section.classList.remove("hidden");
    if (matches.length === 0) {
        section.innerHTML = newGroupFieldsHtml();
    } else {
        section.innerHTML = groupPickerHtml(matches);
        onGroupPickerChange();
    }
}

// Dropdown listing existing groups with this exact roster, plus an
// option to start a brand new group instead.
function groupPickerHtml(matches) {
    // Fall back to the group's own player list if it has no name yet —
    // every match here shares the same roster, so g.groupKey always has it.
    const options = matches
        .map(g => `<option value="${g.id}">${groupDisplayName(g, g.groupKey.split(","))}</option>`)
        .join("");

    return `
        <div class="form-group">
            <label for="game-group-select">Vir watter groep is dit?</label>
            <select id="game-group-select" onchange="onGroupPickerChange()">
                ${options}
                <option value="__new__">➕ Begin 'n nuwe groep met hierdie spelers</option>
            </select>
        </div>
        <div id="game-new-group-fields"></div>`;
}

// Shows the name+goal fields only when "start a new group" is picked
// from the dropdown above.
function onGroupPickerChange() {
    const select = document.getElementById("game-group-select");
    const target = document.getElementById("game-new-group-fields");
    target.innerHTML = (select.value === "__new__") ? newGroupFieldsHtml() : "";
}

// Name + season goal fields shown whenever a brand new group is being
// created (either because no existing group matches, or the user
// explicitly chose "start a new group" from the picker).
function newGroupFieldsHtml() {
    return `
        <div class="form-group">
            <label for="game-group-name">Noem hierdie groep <span class="label-hint">(opsioneel)</span></label>
            <input type="text" id="game-group-name" placeholder="bv. Familie-aand">
        </div>
        <div class="form-group">
            <label for="game-goal">Seisoendoel vir hierdie groep <span class="label-hint">(punte)</span></label>
            <input type="number" id="game-goal" value="${state.config.goal}" placeholder="1000" min="1" inputmode="numeric">
            <small>Nuwe groep! Eerste speler wat hierdie totaal bereik, wen die seisoen.</small>
        </div>`;
}

// Returns names of currently checked players
function checkedPlayers() {
    return [...document.querySelectorAll("#game-player-checkboxes input:checked")]
        .map(cb => cb.value);
}

// Validates inputs and saves the game to Firestore
async function submitGame() {
    const players = checkedPlayers();
    if (players.length < 2) { alert("Kies ten minste 2 spelers."); return; }

    const scores = {};
    for (const p of players) {
        const val = parseInt(document.getElementById(`score-${p}`).value);
        if (isNaN(val) || val < 0) { alert(`Voer 'n geldige telling in vir ${p}.`); return; }
        scores[p] = val;
    }

    const date     = document.getElementById("game-date").value || todayISO();
    // groupKey is a sorted comma-separated player list — used to find groups with this roster
    const groupKey = [...players].sort().join(",");

    // Opened via a specific group's "Add Result" button, and the roster
    // hasn't been edited since? Skip the picker entirely — we already
    // know exactly which group this belongs to.
    const isLocked = lockedGroupId && groupKey === lockedGroupKey;

    // Otherwise: is this result for a brand new group? Either no existing
    // group has this roster at all, or the picker's "start a new group"
    // option is selected. Either way, the dropdown (if present) tells us.
    const select     = isLocked ? null : document.getElementById("game-group-select");
    const isNewGroup = !isLocked && (!select || select.value === "__new__");

    // If new, validate the name/goal fields now, before touching Firestore.
    let newGroupName = "";
    let newGroupGoal = null;
    if (isNewGroup) {
        newGroupName = document.getElementById("game-group-name").value.trim();
        newGroupGoal = parseInt(document.getElementById("game-goal").value);
        if (isNaN(newGroupGoal) || newGroupGoal < 1) {
            alert("Voer 'n geldige seisoendoel in vir hierdie nuwe groep.");
            return;
        }
    }

    // Disable the button and show progress so a slow/failed save is never
    // silently invisible to the user (previously an error here just left
    // the modal sitting there with no feedback at all).
    const saveBtn = document.getElementById("btn-save-game");
    saveBtn.disabled    = true;
    saveBtn.textContent = "Stoor tans…";

    try {
        // groupId is the Firestore doc id that ties this game to one
        // specific scoreboard card. For an existing group it's whatever
        // the picker selected; for a new group we create the group doc
        // first and use the id Firestore hands back.
        let groupId;
        if (isLocked) {
            groupId = lockedGroupId;
        } else if (isNewGroup) {
            const groupRef = await addDoc(collection(db, COL_GROUPS), {
                groupKey,
                name:      newGroupName,
                goal:      newGroupGoal,
                season:    state.config.season ?? 0,
                createdAt: serverTimestamp()
            });
            groupId = groupRef.id;
        } else {
            groupId = select.value;
        }

        await addDoc(collection(db, COL_GAMES), {
            date,
            players,
            scores,
            groupKey,
            groupId,
            gameName: pickGameName(),
            season: state.config.season ?? 0,
            createdAt: serverTimestamp()
        });

        closeAddGame();
    } catch (err) {
        console.error("Failed to save game:", err);
        alert("Kon nie hierdie speletjie stoor nie — gaan jou internetverbinding na en probeer weer.\n\n" + err.message);
    } finally {
        saveBtn.disabled    = false;
        saveBtn.textContent = "Stoor Uitslag";
    }
}

// =====================================================
// REAL-TIME GAMES LISTENER
// Firestore triggers this whenever game data changes
// =====================================================
function listenToGames() {
    const q = query(collection(db, COL_GAMES), orderBy("date", "asc"));

    onSnapshot(q, snap => {
        // Only show games from the current season number
        const currentSeason = state.config.season ?? 0;
        state.games = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(g => (g.season ?? 0) === currentSeason);

        renderGroups();
    });
}

// =====================================================
// RENDER GROUPS & LEADERBOARDS
// =====================================================

function renderGroups() {
    const container = document.getElementById("groups-container");

    if (state.games.length === 0) {
        container.innerHTML =
            `<div class="empty-state"><p>🚂 Nog geen speletjies nie — voeg jou eerste uitslag by!</p></div>`;
        return;
    }

    // Bucket games by bucket key (groupId, or groupKey for legacy games —
    // see bucketKeyFor). Two groups can now share the same roster, so this
    // is no longer simply "one card per unique player combination".
    const buckets = {};
    state.games.forEach(game => {
        const key = bucketKeyFor(game);
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(game);
    });

    container.innerHTML = Object.entries(buckets)
        .map(([bucketKey, games]) => renderGroupSection(bucketKey, games))
        .join("");

    checkForWinners();
}

// Builds the HTML for one group card (header + leaderboard + history)
function renderGroupSection(bucketKey, games) {
    // Every game in a bucket shares the same roster, so any one of them
    // tells us the player list.
    const groupKey = games[0].groupKey;
    const players  = groupKey.split(",");
    const group    = groupByBucketKey(bucketKey);
    const totals   = calcTotals(players, games);
    const sorted   = [...totals].sort((a, b) => b.total - a.total);
    const goal     = group ? Number(group.goal) : Number(state.config.goal);
    const count    = games.length;
    const label    = groupDisplayName(group, players);

    const rows = sorted.map((entry, i) => renderRow(entry, i, goal)).join("");
    const hist = renderHistory(games);

    // JSON.stringify safely escapes the bucketKey so player names with
    // special characters don't break the onclick attribute
    const escapedKey = JSON.stringify(bucketKey);

    return `
        <div class="group-section">
          <div class="group-header">
            <div class="group-title-block">
              <span class="group-title">🚂 ${label}</span>
              ${group && group.name ? `<span class="group-subtitle">${players.join("  ·  ")}</span>` : ""}
            </div>
            <div class="group-header-right">
              <span class="group-goal">🏆 ${goal.toLocaleString()}</span>
              <span class="group-count">${count} game${count !== 1 ? "s" : ""}</span>
              <button class="btn-group-rename"
                      onclick='renameGroup(${escapedKey})'
                      title="Hernoem hierdie groep"
                      aria-label="Hernoem ${players.join(" en ")} se groep">✏️</button>
              <button class="btn-group-add"
                      onclick='addResultToGroup(${escapedKey})'
                      title="Voeg 'n uitslag by vir hierdie groep"
                      aria-label="Voeg 'n uitslag by vir ${players.join(" en ")}">＋</button>
              <button class="btn-group-reset"
                      onclick='resetGroup(${escapedKey})'
                      title="Stel groeptellings terug"
                      aria-label="Stel tellings terug vir ${players.join(" en ")}">🗑</button>
            </div>
          </div>
          <div class="leaderboard">${rows}</div>
          <button class="history-toggle" onclick="toggleHistory(this)">
            <span>Speelgeskiedenis</span>
            <span class="history-arrow">▼</span>
          </button>
          <div class="history-list">${hist}</div>
        </div>`;
}

// Sums each player's scores across a list of games
function calcTotals(players, games) {
    const map = {};
    players.forEach(p => { map[p] = 0; });
    games.forEach(game =>
        Object.entries(game.scores).forEach(([p, pts]) => {
            if (p in map) map[p] += pts;
        })
    );
    return Object.entries(map).map(([name, total]) => ({ name, total }));
}

// Renders one leaderboard row
function renderRow(entry, index, goal) {
    const rank     = index + 1;
    const medal    = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;
    const pct      = Math.min((entry.total / goal) * 100, 100).toFixed(1);
    const isFirst  = index === 0;

    return `
        <div class="leaderboard-row ${isFirst ? "rank-1" : ""}">
          <div class="row-rank ${isFirst ? "gold" : ""}">${medal}</div>
          <div class="row-name">${entry.name}</div>
          <div class="row-progress">
            <div class="progress-track">
              <div class="progress-fill" style="width: ${pct}%"></div>
            </div>
          </div>
          <div class="row-score">${entry.total.toLocaleString()}</div>
        </div>`;
}

// Renders game history list (newest first), each with a delete button
function renderHistory(games) {
    return [...games].reverse().map(game => {
        const chips = Object.entries(game.scores)
            .sort((a, b) => b[1] - a[1])
            .map(([name, pts]) => `<span class="score-chip">${name}: ${pts}</span>`)
            .join("");
        // Older games saved before this feature don't have a gameName.
        const winnerLine = game.gameName
            ? `<div class="history-winner">🏆 <strong>${gameWinner(game)}</strong> in die voorpunt — “${game.gameName}”</div>`
            : "";
        return `
            <div class="history-game">
              ${winnerLine}
              <div class="history-row">
                <span class="history-date">${formatDate(game.date)}</span>
                ${chips}
                <button class="btn-delete-game"
                        onclick="deleteGame('${game.id}')"
                        title="Verwyder hierdie speletjie"
                        aria-label="Verwyder speletjie van ${formatDate(game.date)}">✕</button>
              </div>
            </div>`;
    }).join("");
}

// Deletes ONE game document after confirmation.
// Each game is its own Firestore doc, so nothing else is affected;
// the live listener re-renders totals automatically.
async function deleteGame(id) {
    const game = state.games.find(g => g.id === id);
    if (!game) return;

    const summary = Object.entries(game.scores)
        .map(([name, pts]) => `${name}: ${pts}`)
        .join(", ");

    const confirmed = confirm(
        `Verwyder hierdie speletjie?\n\n${formatDate(game.date)} — ${summary}\n\n` +
        "Dit kan nie ongedaan gemaak word nie."
    );
    if (!confirmed) return;

    await deleteDoc(doc(db, COL_GAMES, id));
}

// Toggles the history panel open/closed
function toggleHistory(btn) {
    const panel = btn.nextElementSibling;
    const arrow = btn.querySelector(".history-arrow");
    panel.classList.toggle("open");
    arrow.classList.toggle("open");
}

// =====================================================
// WINNER DETECTION & CELEBRATION
// =====================================================

// Checks each group separately against that group's own goal.
// (Previously all groups were merged, so a player in two groups
// could "win" without any single group reaching its goal.)
function checkForWinners() {
    // Wait until real per-group goals have loaded (see groupsLoaded)
    if (!groupsLoaded) return;

    // Belt-and-braces guard against firing twice within the SAME
    // session (e.g. two render passes before Firestore echoes our
    // write back). Stored as "bucketKey|player" strings.
    const sessionCelebrated = JSON.parse(sessionStorage.getItem("ttr_celebrated") || "[]");

    // Bucket games the same way the scoreboard does
    const buckets = {};
    state.games.forEach(game => {
        const key = bucketKeyFor(game);
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(game);
    });

    Object.entries(buckets).forEach(([bucketKey, games]) => {
        const group   = groupByBucketKey(bucketKey);
        const goal    = group ? Number(group.goal) : Number(state.config.goal);
        const totals  = calcTotals(games[0].groupKey.split(","), games);
        // Names already celebrated for THIS group, persisted in Firestore —
        // this is what makes a win stay "seen" across page reloads, new
        // browser sessions, and other devices, instead of just this tab.
        const persisted = group?.celebratedWinners || [];

        totals.forEach(({ name, total }) => {
            const celebrationKey  = `${bucketKey}|${name}`;
            const alreadyCelebrated = persisted.includes(name) || sessionCelebrated.includes(celebrationKey);

            if (total >= goal && !alreadyCelebrated) {
                sessionCelebrated.push(celebrationKey);
                sessionStorage.setItem("ttr_celebrated", JSON.stringify(sessionCelebrated));
                showCelebration(name, total);

                // Persist permanently so this group's win for this player
                // never pops up again, on any device.
                if (group) {
                    const updated = [...persisted, name];
                    setDoc(doc(db, COL_GROUPS, group.id), { celebratedWinners: updated }, { merge: true })
                        .catch(err => console.error("Failed to persist celebration state:", err));
                }
            }
        });
    });
}

function showCelebration(name, total) {
    document.getElementById("winner-name").textContent    = name;
    document.getElementById("winner-message").textContent =
        `het ${total.toLocaleString()} punte bereik — Seisoenkampioen! 🎉`;
    document.getElementById("celebration").classList.remove("hidden");
    startConfetti();
}

function closeCelebration() {
    document.getElementById("celebration").classList.add("hidden");
    stopConfetti();
}

// =====================================================
// CONFETTI ANIMATION
// Simple canvas-based coloured rectangles
// =====================================================
const CONFETTI_COLOURS = ["#c0392b", "#d4a017", "#1b2a4a", "#fff8e7", "#f0c040", "#ffffff"];
let confettiId         = null;
let particles          = [];

function startConfetti() {
    const canvas = document.getElementById("confetti-canvas");
    const ctx    = canvas.getContext("2d");
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;

    particles = Array.from({ length: 160 }, () => ({
        x:     Math.random() * canvas.width,
        y:     Math.random() * -canvas.height,
        w:     Math.random() * 10 + 5,
        h:     Math.random() * 5  + 3,
        color: CONFETTI_COLOURS[Math.floor(Math.random() * CONFETTI_COLOURS.length)],
        speed: Math.random() * 3  + 2,
        drift: (Math.random() - 0.5) * 2,
        angle: Math.random() * Math.PI * 2,
        spin:  (Math.random() - 0.5) * 0.15
    }));

    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => {
            p.y     += p.speed;
            p.x     += p.drift;
            p.angle += p.spin;
            // Loop back to top when off-screen
            if (p.y > canvas.height) { p.y = -10; p.x = Math.random() * canvas.width; }
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        });
        confettiId = requestAnimationFrame(draw);
    }

    draw();
}

function stopConfetti() {
    if (confettiId) { cancelAnimationFrame(confettiId); confettiId = null; }
}

// =====================================================
// SETTINGS MODAL
// =====================================================

let settingsPlayers = [];

function openSettings() {
    document.getElementById("modal-settings").classList.remove("hidden");
    document.getElementById("settings-goal").value = state.config.goal;
    document.getElementById("settings-pin").value  = "";
    settingsPlayers = [...state.config.players];
    renderSettingsPlayers();
}

function closeSettings() {
    document.getElementById("modal-settings").classList.add("hidden");
}

function renderSettingsPlayers() {
    document.getElementById("settings-players-list").innerHTML =
        settingsPlayers.map((p, i) =>
            `<span class="player-tag">${p}
             <button onclick="removeSettingsPlayer(${i})" aria-label="Verwyder ${p}">×</button>
             </span>`
        ).join("");
}

function addSettingsPlayer() {
    const input = document.getElementById("settings-player-input");
    const name  = input.value.trim();
    if (!name) return;
    if (settingsPlayers.includes(name)) { alert("Speler bestaan reeds."); return; }
    settingsPlayers.push(name);
    input.value = "";
    renderSettingsPlayers();
}

function removeSettingsPlayer(index) {
    settingsPlayers.splice(index, 1);
    renderSettingsPlayers();
}

// Saves updated settings to Firestore
async function saveSettings() {
    const goal   = parseInt(document.getElementById("settings-goal").value);
    const newPin = document.getElementById("settings-pin").value.trim();

    if (isNaN(goal) || goal < 1)    { alert("Voer 'n geldige doel in."); return; }
    if (settingsPlayers.length < 2) { alert("Hou ten minste 2 spelers."); return; }

    const updated = { ...state.config, goal, players: settingsPlayers };

    if (newPin) {
        if (newPin.length !== 4 || isNaN(newPin)) { alert("PIN moet presies 4 syfers wees."); return; }
        updated.pin = newPin;
    }

    await setDoc(doc(db, COL_CONFIG, "config"), updated);
    state.config = updated;
    updateGoalDisplay();
    closeSettings();
}

// =====================================================
// RESET ALL DATA
// Permanently deletes every game document from Firestore.
// Two-step confirmation to prevent accidental use.
// =====================================================
async function resetAllData() {
    // First warning
    const first = confirm(
        "⚠️ STEL ALLE DATA TERUG\n\n" +
        "Dit sal elke speluitslag permanent van die databasis verwyder.\n\n" +
        "Is jy seker jy wil voortgaan?"
    );
    if (!first) return;

    // Second warning — requires typing HERSTEL
    const second = prompt(
        "Laaste kans — dit kan nie ongedaan gemaak word nie.\n\nTik  HERSTEL  om te bevestig:"
    );
    if (second === null || second.trim() !== "HERSTEL") {
        alert("Terugstel gekanselleer.");
        return;
    }

    // Fetch and delete all game AND group documents
    // Firestore has no bulk delete — we delete each doc individually
    const gamesSnap  = await getDocs(collection(db, COL_GAMES));
    const groupsSnap = await getDocs(collection(db, COL_GROUPS));
    await Promise.all([
        ...gamesSnap.docs.map(d => deleteDoc(d.ref)),
        ...groupsSnap.docs.map(d => deleteDoc(d.ref))
    ]);

    // Clear the season start so nothing is filtered
    const updated = { ...state.config, seasonStart: null };
    await setDoc(doc(db, COL_CONFIG, "config"), updated);
    state.config = updated;

    sessionStorage.removeItem("ttr_celebrated");
    closeSettings();
    alert("Alle speldata is teruggestel.");
}

// =====================================================
// RESET ONE GROUP
// Deletes all games in a single group's bucket for the current season.
// The Firestore listener re-renders automatically once docs are removed.
// =====================================================
async function resetGroup(bucketKey) {
    const groupGames = state.games.filter(g => bucketKeyFor(g) === bucketKey);
    if (groupGames.length === 0) return;

    const players = groupGames[0].groupKey.split(",").join(" · ");
    const count   = groupGames.length;

    const confirmed = confirm(
        `Stel tellings terug vir ${players}?\n\n` +
        `Dit sal ${count} speletjie${count !== 1 ? "s" : ""} vir hierdie groep verwyder.\n\n` +
        "Die groep sal 'n nuwe seisoendoel stel met hul volgende speletjie.\n\n" +
        "Dit kan nie ongedaan gemaak word nie."
    );
    if (!confirmed) return;

    // Delete the group's games AND its goal doc, so the goal
    // is asked again when this group starts playing again
    const groupDoc = groupByBucketKey(bucketKey);
    await Promise.all([
        ...groupGames.map(g => deleteDoc(doc(db, COL_GAMES, g.id))),
        ...(groupDoc ? [deleteDoc(doc(db, COL_GROUPS, groupDoc.id))] : [])
    ]);
}

// =====================================================
// RENAME GROUP
// =====================================================
async function renameGroup(bucketKey) {
    const group = groupByBucketKey(bucketKey);
    if (!group) {
        alert("Kan nie hierdie groep hernoem nie — die data lyk onvolledig.");
        return;
    }

    const input = prompt(
        "Noem hierdie groep (los leeg om net die spelernaamlys te wys):",
        group.name || ""
    );
    if (input === null) return; // cancelled
    const newName = input.trim();

    try {
        await setDoc(doc(db, COL_GROUPS, group.id), { name: newName }, { merge: true });

        // Legacy groups (created before groups had names) are only linked
        // to their games via groupKey, not groupId — see bucketKeyFor().
        // Now that this group has a name, backfill groupId onto those
        // games too, so it's unambiguous even if another group is later
        // created with this same roster (the exact bug fixed earlier).
        const legacyGames = state.games.filter(g => !g.groupId && g.groupKey === group.groupKey);
        await Promise.all(
            legacyGames.map(g => setDoc(doc(db, COL_GAMES, g.id), { groupId: group.id }, { merge: true }))
        );
    } catch (err) {
        console.error("Failed to rename group:", err);
        alert("Kon nie hierdie groep hernoem nie — gaan jou internetverbinding na en probeer weer.\n\n" + err.message);
    }
}

// =====================================================
// NEW SEASON
// Records a seasonStart date in config.
// Games before that date are hidden from the scoreboard.
// Old data is never deleted from Firestore.
// =====================================================
async function newSeason() {
    const confirmed = confirm(
        "Begin 'n nuwe seisoen?\n\n" +
        "Die huidige puntebord sal terugstel. Alle vorige speelgeskiedenis " +
        "word veilig in die databasis gehou, maar sal nie op die bord verskyn nie."
    );
    if (!confirmed) return;

    // Increment the season number — old games stay in Firestore but won't show
    const updated = { ...state.config, season: (state.config.season ?? 0) + 1 };
    await setDoc(doc(db, COL_CONFIG, "config"), updated);

    state.config = updated;
    sessionStorage.removeItem("ttr_celebrated");
    closeSettings();
    // Manually re-filter and re-render — the Firestore listener won't fire
    // on its own because no game documents changed, only the config did.
    // Groups are filtered too, so every group sets a fresh goal next season.
    const currentSeason = updated.season;
    state.games  = state.games.filter(g => (g.season ?? 0) === currentSeason);
    state.groups = state.groups.filter(g => (g.season ?? 0) === currentSeason);
    renderGroups();
}

// =====================================================
// UTILITIES
// =====================================================

// Returns today's date as "YYYY-MM-DD"
function todayISO() {
    return new Date().toISOString().split("T")[0];
}

// Formats "YYYY-MM-DD" as "12 Jun 2026"
function formatDate(str) {
    if (!str) return "";
    // Append T00:00:00 to avoid UTC off-by-one on some browsers
    const d = new Date(str + "T00:00:00");
    return d.toLocaleDateString("af-ZA", { day: "numeric", month: "short", year: "numeric" });
}

// =====================================================
// EXPOSE FUNCTIONS TO HTML onclick HANDLERS
// ES modules don't attach to window automatically
// =====================================================
window.checkPin             = checkPin;
window.addSetupPlayer       = addSetupPlayer;
window.removeSetupPlayer    = removeSetupPlayer;
window.saveSetup            = saveSetup;
window.openAddGame          = openAddGame;
window.addResultToGroup     = addResultToGroup;
window.closeAddGame         = closeAddGame;
window.updateScoreInputs    = updateScoreInputs;
window.onGroupPickerChange  = onGroupPickerChange;
window.submitGame           = submitGame;
window.deleteGame           = deleteGame;
window.toggleHistory        = toggleHistory;
window.closeCelebration     = closeCelebration;
window.openSettings         = openSettings;
window.closeSettings        = closeSettings;
window.addSettingsPlayer    = addSettingsPlayer;
window.removeSettingsPlayer = removeSettingsPlayer;
window.saveSettings         = saveSettings;
window.newSeason            = newSeason;
window.resetAllData         = resetAllData;
window.resetGroup           = resetGroup;
window.renameGroup          = renameGroup;

// =====================================================
// BOOT
// =====================================================
init();
