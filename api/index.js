// =============================================================================
// VALORANT API PROXY FOR VERCEL (Node.js Serverless)
// Кэширование + защита от 429/503 + поддержка кастомных шаблонов чата
// =============================================================================

const cache = new Map();
const inFlight = new Map();

const TTL = {
  mmr: 50_000,
  history: 50_000,
  matches: 55_000,
  stored: 55_000,
  season: 120_000,
  account: 300_000
};

const FETCH_TIMEOUT_MS = 8500;
const MAX_CACHE_ENTRIES = 250;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const parsedUrl = new URL(req.url, "http://localhost");
  const q = parsedUrl.searchParams;

  const action = (q.get("action") || "widget").toLowerCase();

  if (action === "ping") {
    return res.status(200).json({
      status: "ok",
      platform: "vercel-nodejs",
      cacheEntries: cache.size,
      time: new Date().toISOString()
    });
  }

  const region = (q.get("region") || "eu").toLowerCase();
  const name = (q.get("name") || "").trim();
  const tag = (q.get("tag") || "").trim();
  const apiKey = (q.get("key") || "").trim();
  const displayUser = q.get("displayUser") || "@Зритель";
  const chatTpl = (q.get("chatTpl") || "").trim();
  const chatTpl2 = (q.get("chatTpl2") || "").trim();

  if (!name || !tag || !apiKey) {
    return res.status(200).json({
      status: "error",
      chatMsg: `${displayUser}, ❌ Ошибка: не указаны ник, тег или API ключ.`,
      refund: true
    });
  }

  const headers = {
    "Authorization": apiKey,
    "User-Agent": "VercelProxy-StreamerBot/3.1"
  };

  const encName = encodeURIComponent(name);
  const encTag = encodeURIComponent(tag);
  const playerKey = `${region}:${name.toLowerCase()}#${tag.toLowerCase()}`;

  try {
    // =========================================================================
    // 1. ГЛАВНЫЙ ВИДЖЕТ СТРИМА (action=widget)
    // =========================================================================
    if (action === "widget") {
      const resetTime = parseInt(q.get("resetTime") || "0", 10);

      const [mmrRes, histRes] = await Promise.all([
        getMmrV3(playerKey, region, encName, encTag, headers),
        getMmrHistory(playerKey, region, encName, encTag, headers)
      ]);

      if (!mmrRes.ok) {
        return res.status(200).json({ status: "error", message: "MMR fetch failed" });
      }

      const mmrJson = mmrRes.data;
      const rankName = mmrJson?.data?.current?.tier?.name || "Unranked";
      const tierId = mmrJson?.data?.current?.tier?.id || 0;
      const rr = mmrJson?.data?.current?.rr ?? 0;
      const elo = mmrJson?.data?.current?.elo ?? 0;
      const lastChange = mmrJson?.data?.current?.last_change ?? 0;
      const { peakRank, peakEp } = parsePeak(mmrJson);

      const rrChanges = {};
      const histArr = histRes.ok && Array.isArray(histRes.data?.data) ? histRes.data.data : [];
      for (const m of histArr) {
        if (m.match_id) rrChanges[m.match_id] = m.mmr_change_to_last_game ?? 0;
      }

      let w = 0, l = 0, netRR = 0;
      let totalK = 0, totalD = 0, totalHS = 0, totalBS = 0, totalLS = 0;
      const streamAgents = [];

      const newestHistTime = histArr.length > 0 ? (histArr[0]?.date_raw ?? 0) : 0;
      const definitelyNoGamesSinceReset = newestHistTime > 0 && newestHistTime < (resetTime - 7200);

      if (resetTime > 0 && !definitelyNoGamesSinceReset) {
        const matchRes = await getMatches(playerKey, region, encName, encTag, 10, headers);
        if (matchRes.ok) {
          const mArr = Array.isArray(matchRes.data) ? matchRes.data : [];

          for (const match of mArr) {
            const gameStart = match?.metadata?.game_start ?? 0;
            if (gameStart < resetTime) continue;

            const players = match?.players?.all_players || [];
            const me = findPlayer(players, name, tag);
            if (!me) continue;

            const matchId = match?.metadata?.matchid || "";
            const myTeam = (me.team || "Red").toLowerCase();
            const enemyTeam = myTeam === "red" ? "blue" : "red";
            const myScore = match?.teams?.[myTeam]?.rounds_won ?? 0;
            const enemyScore = match?.teams?.[enemyTeam]?.rounds_won ?? 0;
            const hasWon = match?.teams?.[myTeam]?.has_won ?? false;

            if (hasWon) w++;
            else if (myScore < enemyScore) l++;

            netRR += (rrChanges[matchId] ?? 0);

            totalK += (me?.stats?.kills ?? 0);
            totalD += (me?.stats?.deaths ?? 0);
            totalHS += (me?.stats?.headshots ?? 0);
            totalBS += (me?.stats?.bodyshots ?? 0);
            totalLS += (me?.stats?.legshots ?? 0);

            streamAgents.unshift(normalizeAgent(me.character));
          }
        }
      }

      const totalGames = w + l;
      const kd = totalGames === 0 ? "0.00" : (totalD === 0 ? totalK.toFixed(2) : (totalK / totalD).toFixed(2));
      const shots = totalHS + totalBS + totalLS;
      const hsPercent = (totalGames === 0 || shots === 0) ? 0 : Math.round((totalHS / shots) * 100);
      const wr = totalGames === 0 ? 0 : Math.round((w / totalGames) * 100);
      const netRRStr = netRR > 0 ? `+${netRR}` : `${netRR}`;

      return res.status(200).json({
        status: "ok",
        name, tag,
        rank: rankName,
        tierId, rr, elo,
        lastChange: lastChange >= 0 ? `+${lastChange}` : `${lastChange}`,
        peakRank, peakEp,
        w, l, totalGames, wr,
        netRR, netRRStr,
        kd, hs: hsPercent,
        agents: streamAgents,
        agentsCsv: streamAgents.join(",")
      });
    }

    // =========================================================================
    // 2 & 3. DAY STATS И LAST 10 (action=daystats | action=last10)
    // =========================================================================
    if (action === "daystats" || action === "last10") {
      const isDay = action === "daystats";
      const iconMode = q.get("iconMode") || "alt";

      const [matchRes, histRes] = await Promise.all([
        getMatches(playerKey, region, encName, encTag, 10, headers),
        getMmrHistory(playerKey, region, encName, encTag, headers)
      ]);

      if (!matchRes.ok) {
        return res.status(200).json({ status: "error", chatMsg: `${displayUser}, ❌ Ошибка поиска данных.`, refund: true });
      }

      const rrChanges = {};
      if (histRes.ok && Array.isArray(histRes.data?.data)) {
        for (const m of histRes.data.data) {
          if (m.match_id) rrChanges[m.match_id] = m.mmr_change_to_last_game ?? 0;
        }
      }

      const mArr = Array.isArray(matchRes.data) ? matchRes.data : [];
      if (mArr.length === 0) {
        return res.status(200).json({ status: "empty", chatMsg: `${displayUser}, не найдено соревновательных игр.`, refund: true });
      }

      const twentyFourHoursAgo = Math.floor(Date.now() / 1000) - 86400;
      let totalW = 0, totalL = 0, totalDraw = 0, totalRR = 0;
      const matchesJson = [];
      const chatMatchDetails = [];

      for (const match of mArr) {
        const gameStart = match?.metadata?.game_start ?? 0;
        if (isDay && gameStart < twentyFourHoursAgo) continue;

        const players = match?.players?.all_players || [];
        const me = findPlayer(players, name, tag);
        if (!me) continue;

        const myTeam = (me.team || "Red").toLowerCase();
        const enemyTeam = myTeam === "red" ? "blue" : "red";
        const { isMatchMVP, isTeamMVP } = checkMVP(players, me, myTeam);

        const matchId = match?.metadata?.matchid || "";
        const mapName = match?.metadata?.map || "Unknown";
        const aName = normalizeAgent(me.character);

        const myScore = match?.teams?.[myTeam]?.rounds_won ?? 0;
        const enemyScore = match?.teams?.[enemyTeam]?.rounds_won ?? 0;
        const hasWon = match?.teams?.[myTeam]?.has_won ?? false;

        const k = me?.stats?.kills ?? 0;
        const d = me?.stats?.deaths ?? 0;
        const a = me?.stats?.assists ?? 0;

        let resultStr = "DRAW";
        let matchIcon = "⚪";
        if (hasWon) {
          resultStr = "WIN";
          totalW++;
          matchIcon = "🟢";
        } else if (myScore === enemyScore) {
          totalDraw++;
        } else {
          resultStr = "LOSE";
          totalL++;
          matchIcon = "🔴";
        }

        const gameRR = rrChanges[matchId] ?? 0;
        totalRR += gameRR;
        const gameRRStr = gameRR > 0 ? `+${gameRR}` : `${gameRR}`;
        const mvpIcon = isMatchMVP ? "👑" : (isTeamMVP ? "🏅" : "");

        chatMatchDetails.push(`${matchIcon}${mvpIcon} ${mapName} ${myScore}:${enemyScore} (${gameRRStr})`);

        matchesJson.push({
          map: mapName, agent: aName, result: resultStr,
          myScore, enemyScore, k, d, a, rr: gameRRStr,
          isMatchMVP, isTeamMVP
        });
      }

      if (matchesJson.length === 0) {
        const emptyMsg = isDay
          ? `${displayUser}, за последние 24 часа ${name}#${tag} еще не играл в рейтинг!`
          : `${displayUser}, ${name}#${tag} еще не играл в рейтинг!`;
        return res.status(200).json({ status: "empty", chatMsg: emptyMsg, refund: true });
      }

      const totalRRStr = `${totalRR > 0 ? "+" : ""}${totalRR}`;
      const chatTitle = isDay ? "ЗА 24 ЧАСА" : "ПОСЛЕДНИЕ 10 ИГР";
      const overlayTitle = isDay ? "ИТОГИ ЗА 24 ЧАСА" : "ПОСЛЕДНИЕ 10 ИГР";
      const matchesStr = chatMatchDetails.join(" 🔹 ");

      const defaultMsg = `${displayUser}, 📊 ${chatTitle} (${name}#${tag}): ${totalW}W-${totalL}L | Общее RR: ${totalRRStr} 📈 | ${matchesStr}`;
      const finalChatMsg = renderChatTpl(chatTpl, {
        user: displayUser,
        name, tag,
        w: totalW,
        l: totalL,
        draw: totalDraw,
        games: matchesJson.length,
        totalRR: totalRRStr,
        matches: matchesStr
      }, defaultMsg);

      return res.status(200).json({
        status: "ok",
        chatMsg: finalChatMsg,
        overlayData: {
          name, tag, iconMode,
          title: overlayTitle,
          w: totalW, l: totalL, totalRR,
          gamesCount: matchesJson.length,
          matches: matchesJson
        }
      });
    }

    // =========================================================================
    // 4. FULL STATS (action=fullstats)
    // =========================================================================
    if (action === "fullstats") {
      const mainIcon = q.get("mainIcon") || "orig";
      const recentIcon = q.get("recentIcon") || "orig";

      const [accRes, mmrRes, matchRes, histRes] = await Promise.all([
        getAccount(playerKey, encName, encTag, headers),
        getMmrV3(playerKey, region, encName, encTag, headers),
        getMatches(playerKey, region, encName, encTag, 10, headers),
        getMmrHistory(playerKey, region, encName, encTag, headers)
      ]);

      if (!mmrRes.ok) {
        return res.status(200).json({ status: "error", chatMsg: `❌ ${displayUser}, профиль ${name}#${tag} не найден!`, refund: true });
      }

      const accLevel = accRes.ok ? (accRes.data?.data?.account_level ?? 0) : 0;
      const jMMR = mmrRes.data;
      const rankName = jMMR?.data?.current?.tier?.name || "Unranked";
      const rr = jMMR?.data?.current?.rr ?? 0;
      const elo = String(jMMR?.data?.current?.elo ?? "0");
      const { peakRank, peakEp } = parsePeak(jMMR);

      let games = 0, w = 0, l = 0, k = 0, d = 0, rds = 0, dmg = 0, hs = 0, bs = 0, ls = 0;
      let fb = 0, fd = 0, maxKills = 0, ace = 0, quad = 0, triple = 0, doubleKill = 0;
      let bestAgentName = "Unknown";
      const recentAgentsList = [];

      if (matchRes.ok) {
        const mArr = Array.isArray(matchRes.data) ? matchRes.data : [];
        const agentPlays = {};
        let targetPuuid = "";

        for (const m of mArr) {
          const players = m?.players?.all_players || [];
          const me = findPlayer(players, name, tag, targetPuuid);
          if (!me) continue;

          targetPuuid = me.puuid || targetPuuid;
          games++;
          rds += (m?.metadata?.rounds_played ?? 0);
          const curK = me?.stats?.kills ?? 0;
          k += curK;
          if (curK > maxKills) maxKills = curK;
          d += (me?.stats?.deaths ?? 0);
          dmg += (me?.damage_made ?? 0);
          hs += (me?.stats?.headshots ?? 0);
          bs += (me?.stats?.bodyshots ?? 0);
          ls += (me?.stats?.legshots ?? 0);

          const killsArr = Array.isArray(m?.kills) ? m.kills : [];
          const roundStats = analyzeRounds(killsArr, targetPuuid);
          fb += roundStats.fb;
          fd += roundStats.fd;
          ace += roundStats.ace;
          quad += roundStats.quad;
          triple += roundStats.triple;
          doubleKill += roundStats.doubleKill;

          if (me.character) {
            const charName = normalizeAgent(me.character);
            agentPlays[charName] = (agentPlays[charName] || 0) + 1;
            if (recentAgentsList.length < 10) recentAgentsList.unshift(charName);
          }

          const myTeam = (me.team || "Red").toLowerCase();
          const enemyTeam = myTeam === "red" ? "blue" : "red";
          const myScore = m?.teams?.[myTeam]?.rounds_won ?? 0;
          const enemyScore = m?.teams?.[enemyTeam]?.rounds_won ?? 0;
          const hasWon = m?.teams?.[myTeam]?.has_won ?? false;
          if (hasWon) w++;
          else if (myScore < enemyScore) l++;
        }

        bestAgentName = pickTopAgent(agentPlays);
      }

      if (games === 0) {
        return res.status(200).json({
          status: "empty",
          chatMsg: `${displayUser}, за последние 10 матчей ${name}#${tag} не сыграл ни одной соревновательной игры.`,
          refund: true
        });
      }

      let totalRR = 0;
      if (histRes.ok && Array.isArray(histRes.data?.data)) {
        const hArr = histRes.data.data;
        const limit = Math.min(games, hArr.length);
        for (let i = 0; i < limit; i++) {
          totalRR += (hArr[i]?.mmr_change_to_last_game ?? 0);
        }
      }

      const changeStr = totalRR >= 0 ? `+${totalRR}` : `${totalRR}`;
      const kd = d === 0 ? k.toFixed(2) : (k / d).toFixed(2);
      const totalShots = hs + bs + ls;
      const hsP = totalShots === 0 ? "0" : Math.round((hs / totalShots) * 100).toString();
      const adr = rds === 0 ? "0" : Math.round(dmg / rds).toString();
      const wr = (w + l) === 0 ? 0 : Math.round((w / (w + l)) * 100);
      const recentStr = recentAgentsList.join(",");

      const defaultMsg = `${displayUser}, 📋 ДОСЬЕ ${name}#${tag} (За ${games} игр): 🏆 ${rankName} (${rr} RR) (Итог: ${changeStr} RR) | 🎮 ${w}W-${l}L (${wr}%). 🎯 K/D: ${kd} | HS: ${hsP}%. 🩸 FB/FD: ${fb}/${fd}. 🔫 Мейн: ${bestAgentName}`;
      const chatMsg = renderChatTpl(chatTpl, {
        user: displayUser,
        name, tag, games,
        rank: rankName, rr,
        change: changeStr, elo,
        peak: peakRank, peakEp,
        lvl: accLevel,
        w, l, wr, kd,
        hs: hsP, adr,
        fb, fd,
        maxk: maxKills,
        agent: bestAgentName,
        ace, "4k": quad, "3k": triple, "2k": doubleKill
      }, defaultMsg);

      const urlArgs = `?name=${encName}&tag=${encTag}&mainIcon=${mainIcon}&recentIcon=${recentIcon}&lvl=${accLevel}&rank=${encodeURIComponent(rankName)}&rr=${rr}&change=${encodeURIComponent(changeStr)}&elo=${elo}&peak=${encodeURIComponent(peakRank)}&peakEp=${encodeURIComponent(peakEp)}&w=${w}&l=${l}&wr=${wr}&games=${games}&agentName=${encodeURIComponent(bestAgentName)}&recent=${encodeURIComponent(recentStr)}&kd=${kd}&hs=${hsP}&adr=${adr}&fb=${fb}&fd=${fd}&maxk=${maxKills}&ace=${ace}&4k=${quad}&3k=${triple}&2k=${doubleKill}`;

      return res.status(200).json({ status: "ok", chatMsg, urlArgs });
    }

    // =========================================================================
    // 5. LAST GAME (action=lastgame)
    // =========================================================================
    if (action === "lastgame") {
      const iconMode = q.get("iconMode") || "alt";

      const [mmrRes, matchRes] = await Promise.all([
        getMmrV3(playerKey, region, encName, encTag, headers),
        getMatches(playerKey, region, encName, encTag, 1, headers)
      ]);

      if (!mmrRes.ok) {
        return res.status(200).json({
          status: "error",
          chatMsg: `${displayUser}, 🕵️‍♂️ Не могу найти данные по ${name}#${tag}. Возможно, неверный ник, аккаунт скрыт в настройках, или он так давно не играл, что Риоты сдали его профиль в музей! 🕸️🐁`,
          refund: true
        });
      }

      const rrChange = mmrRes.data?.data?.current?.last_change ?? 0;

      if (!matchRes.ok) {
        return res.status(200).json({
          status: "error",
          chatMsg: `${displayUser}, ❌ Ошибка связи с серверами Valorant! Попробуй позже.`,
          refund: false
        });
      }

      const mArr = Array.isArray(matchRes.data) ? matchRes.data : [];
      if (mArr.length === 0) {
        return res.status(200).json({
          status: "empty",
          chatMsg: `${displayUser}, 🤷 У ${name}#${tag} нет недавних соревновательных игр! Возможно, аккаунт скрыт в трекере, либо ктото боится слить ранг и играет только в спайк раш... 🐔💨`,
          refund: true
        });
      }

      const match = mArr[0];
      const mapName = match?.metadata?.map || "Unknown";
      const rds = match?.metadata?.rounds_played ?? 0;
      const players = match?.players?.all_players || [];
      const me = findPlayer(players, name, tag);

      if (!me) {
        return res.status(200).json({ status: "empty", chatMsg: `${displayUser}, не удалось найти игрока в последнем матче.`, refund: true });
      }

      const myTeam = (me.team || "Red").toLowerCase();
      const enemyTeam = myTeam === "red" ? "blue" : "red";
      const { isMatchMVP, isTeamMVP } = checkMVP(players, me, myTeam);

      const agentName = normalizeAgent(me.character);
      const k = me?.stats?.kills ?? 0;
      const d = me?.stats?.deaths ?? 0;
      const a = me?.stats?.assists ?? 0;
      const dmg = me?.damage_made ?? 0;
      const hs = me?.stats?.headshots ?? 0;
      const bs = me?.stats?.bodyshots ?? 0;
      const ls = me?.stats?.legshots ?? 0;

      const myScore = match?.teams?.[myTeam]?.rounds_won ?? 0;
      const enemyScore = match?.teams?.[enemyTeam]?.rounds_won ?? 0;
      const hasWon = match?.teams?.[myTeam]?.has_won ?? false;

      let matchResult = "НИЧЬЯ";
      if (hasWon) matchResult = "ПОБЕДА";
      else if (myScore !== enemyScore) matchResult = "ПОРАЖЕНИЕ";

      const killsArr = Array.isArray(match?.kills) ? match.kills : [];
      const { fb, fd, ace, quad, triple, doubleKill } = analyzeRounds(killsArr, me.puuid);

      const kd = d === 0 ? k.toFixed(2) : (k / d).toFixed(2);
      const adr = rds === 0 ? "0" : Math.round(dmg / rds).toString();
      const totalShots = hs + bs + ls;
      const hsP = totalShots === 0 ? "0" : Math.round((hs / totalShots) * 100).toString();
      const bsP = totalShots === 0 ? "0" : Math.round((bs / totalShots) * 100).toString();
      const lsP = totalShots === 0 ? "0" : Math.round((ls / totalShots) * 100).toString();

      const rrString = rrChange >= 0 ? `+${rrChange}` : `${rrChange}`;
      const chatMatchResult = matchResult === "ПОБЕДА" ? "🟢 ПОБЕДА" : (matchResult === "ПОРАЖЕНИЕ" ? "🔴 ПОРАЖЕНИЕ" : "⚪ НИЧЬЯ");
      const mvpChatIcon = isMatchMVP ? "👑" : (isTeamMVP ? "🏅" : "");
      const scoreColon = `${myScore}:${enemyScore}`;

      const defaultMsg = `${displayUser}, ${mvpChatIcon ? mvpChatIcon + " " : ""}${name}#${tag} | ${chatMatchResult} на ${mapName} (${scoreColon}). 🔫 ${agentName}: ${k}/${d}/${a} (K/D ${kd}). 🎯 HS: ${hsP}%. 📈 Итог: ${rrString} RR.`;
      const chatMsg = renderChatTpl(chatTpl, {
        user: displayUser,
        name, tag,
        mvp: mvpChatIcon,
        result: chatMatchResult,
        map: mapName,
        score: scoreColon,
        agent: agentName,
        k, d, a, kd,
        hs: hsP, bs: bsP, ls: lsP,
        adr, rr: rrString,
        fb, fd,
        ace, "4k": quad, "3k": triple, "2k": doubleKill
      }, defaultMsg);

      const urlArgs = `?name=${encName}&tag=${encTag}&iconMode=${iconMode}&agent=${encodeURIComponent(agentName)}&map=${encodeURIComponent(mapName)}&result=${encodeURIComponent(matchResult)}&score=${myScore}-${enemyScore}&k=${k}&d=${d}&a=${a}&rr=${encodeURIComponent(rrString)}&kd=${kd}&hs=${hsP}&bs=${bsP}&ls=${lsP}&adr=${adr}&fb=${fb}&fd=${fd}&maxk=${k}&ace=${ace}&4k=${quad}&3k=${triple}&2k=${doubleKill}&isMatchMVP=${isMatchMVP}&isTeamMVP=${isTeamMVP}`;

      return res.status(200).json({ status: "ok", chatMsg, urlArgs });
    }

    // =========================================================================
    // 6. MATCH SCOREBOARD (action=scoreboard)
    // =========================================================================
    if (action === "scoreboard") {
      const matchIndex = Math.min(Math.max(parseInt(q.get("matchIndex") || "1", 10) || 1, 1), 10);
      const arrayIndex = matchIndex - 1;
      const streamerName = q.get("streamer") || name;
      const teamTitle = q.get("teamTitle") || "Команда стримера!";
      const iconMode = q.get("iconMode") || "orig";

      const matchRes = await getMatches(playerKey, region, encName, encTag, matchIndex, headers);
      if (!matchRes.ok) {
        return res.status(200).json({ status: "error", chatMsg: `${displayUser}, ❌ Ошибка сервера Valorant API. Баллы возвращены 💸`, refund: true });
      }

      const mArr = Array.isArray(matchRes.data) ? matchRes.data : [];
      if (mArr.length === 0) {
        return res.status(200).json({ status: "empty", chatMsg: `${displayUser}, не найдено соревновательных игр. Баллы возвращены 💸`, refund: true });
      }

      if (arrayIndex >= mArr.length) {
        return res.status(200).json({
          status: "empty",
          chatMsg: `${displayUser}, у ${name} нет ${matchIndex}-го матча в истории. Найдено только ${mArr.length}. Баллы возвращены 💸`,
          refund: true
        });
      }

      const match = mArr[arrayIndex];
      const mapName = match?.metadata?.map || "Unknown";
      const mode = match?.metadata?.mode || "Unknown";
      const allPlayers = match?.players?.all_players || [];

      const me = findPlayer(allPlayers, name, tag);
      const myTeam = me ? (me.team || "Red").toLowerCase() : "red";
      const enemyTeam = myTeam === "red" ? "blue" : "red";

      const myScore = match?.teams?.[myTeam]?.rounds_won ?? 0;
      const enemyScore = match?.teams?.[enemyTeam]?.rounds_won ?? 0;
      const hasWon = match?.teams?.[myTeam]?.has_won ?? false;

      let resultStr = "DRAW";
      let chatResultIcon = "⚪";
      if (hasWon) { resultStr = "WIN"; chatResultIcon = "🟢"; }
      else if (myScore < enemyScore) { resultStr = "LOSE"; chatResultIcon = "🔴"; }

      const myTeamArr = [];
      const enemyTeamArr = [];

      for (const p of allPlayers) {
        const pName = p.name || "Unknown";
        const pTag = p.tag || "";
        const agent = normalizeAgent(p.character);
        const rank = p.currenttier_patched || "Unranked";
        const team = (p.team || "Red").toLowerCase();
        const k = p?.stats?.kills ?? 0;
        const d = p?.stats?.deaths ?? 0;
        const a = p?.stats?.assists ?? 0;
        const score = p?.stats?.score ?? 0;
        const kdRatio = d === 0 ? k.toFixed(2) : (k / d).toFixed(2);

        const pObj = {
          name: pName, tag: pTag, agent, rank,
          k, d, a, kd: kdRatio, score,
          isStreamer: pName.toLowerCase() === name.toLowerCase() && pTag.toLowerCase() === tag.toLowerCase()
        };

        if (team === myTeam) myTeamArr.push(pObj);
        else enemyTeamArr.push(pObj);
      }

      myTeamArr.sort((a, b) => b.score - a.score);
      enemyTeamArr.sort((a, b) => b.score - a.score);

      const myTeamStr = myTeamArr.map(p => `${p.name}#${p.tag} [${p.agent}]: ${p.k}/${p.d}/${p.a}`).join(" | ");
      const enemyTeamStr = enemyTeamArr.map(p => `${p.name}#${p.tag} [${p.agent}]: ${p.k}/${p.d}/${p.a}`).join(" | ");
      const scoreDash = `${myScore}-${enemyScore}`;

      const defaultTeam1 = `${displayUser}, 🟢 ${teamTitle} (${mapName} ${chatResultIcon} ${scoreDash}): ${myTeamStr}`;
      const defaultTeam2 = `🔴 Соперники: ${enemyTeamStr}`;

      const scoreVars = {
        user: displayUser,
        name, tag,
        teamTitle,
        map: mapName,
        resultIcon: chatResultIcon,
        score: scoreDash,
        myTeam: myTeamStr,
        enemyTeam: enemyTeamStr
      };

      const myTeamMsg = renderChatTpl(chatTpl, scoreVars, defaultTeam1);
      const enemyTeamMsg = renderChatTpl(chatTpl2, scoreVars, defaultTeam2);

      return res.status(200).json({
        status: "ok",
        myTeamMsg,
        enemyTeamMsg,
        overlayData: {
          streamer: streamerName,
          map: mapName, mode,
          result: resultStr,
          myScore, enemyScore,
          myTeam: myTeamArr,
          enemyTeam: enemyTeamArr,
          iconMode
        }
      });
    }

    // =========================================================================
    // 7. RANK CHECK (action=rank)
    // =========================================================================
    if (action === "rank") {
      const iconMode = q.get("iconMode") || "alt";

      const [accRes, mmrRes, agentStats] = await Promise.all([
        getAccount(playerKey, encName, encTag, headers),
        getMmrV3(playerKey, region, encName, encTag, headers),
        getTopAgentFast(playerKey, region, name, tag, encName, encTag, headers)
      ]);

      if (!mmrRes.ok) {
        return res.status(200).json({
          status: "error",
          chatMsg: `${displayUser}, 🕵️‍♂️ Мы перерыли все сервера Riot, но ${name}#${tag} словно испарился! Либо аккаунт выдуман, либо он покрылся вековой пылью.`,
          refund: true
        });
      }

      const accLevel = accRes.ok ? (accRes.data?.data?.account_level ?? 0) : 0;
      const jMMR = mmrRes.data;
      const rankName = jMMR?.data?.current?.tier?.name || "Unranked";
      const rr = jMMR?.data?.current?.rr ?? 0;
      const elo = String(jMMR?.data?.current?.elo ?? "0");
      const chg = jMMR?.data?.current?.last_change ?? 0;
      const changeStr = chg >= 0 ? `+${chg}` : `${chg}`;
      const { peakRank, peakEp } = parsePeak(jMMR);

      const { games, bestAgentName } = agentStats;

      if (rankName.toLowerCase() === "unranked" && games === 0) {
        return res.status(200).json({ status: "empty", chatMsg: `${displayUser}, 😴 ${name}#${tag} без ранга. Ждем камбека!`, refund: true });
      }

      const agentDisplay = bestAgentName !== "Unknown" ? bestAgentName : "Скрыт 🥷";
      const agentText = bestAgentName !== "Unknown" ? `Мейн: ${bestAgentName} 🔫` : "Мейн: Скрыт 🥷";
      const defaultMsg = `${displayUser}, 🔥 ${name}#${tag} ➔ Текущий: ${rankName} (${rr} RR) | Пик: ${peakRank} 👑 | ${agentText}`;

      const chatMsg = renderChatTpl(chatTpl, {
        user: displayUser,
        name, tag,
        rank: rankName, rr,
        change: changeStr, elo,
        peak: peakRank, peakEp,
        lvl: accLevel,
        agent: agentDisplay,
        games
      }, defaultMsg);

      const urlArgs = `?name=${encName}&tag=${encTag}&iconMode=${iconMode}&lvl=${accLevel}&rank=${encodeURIComponent(rankName)}&rr=${rr}&change=${encodeURIComponent(changeStr)}&elo=${elo}&peak=${encodeURIComponent(peakRank)}&peakEp=${encodeURIComponent(peakEp)}&games=${games}&agentName=${encodeURIComponent(bestAgentName)}`;

      return res.status(200).json({ status: "ok", chatMsg, urlArgs });
    }

    // =========================================================================
    // 8. SEASON STATS (action=season)
    // =========================================================================
    if (action === "season") {
      const mmrV2Res = await getMmrV2(playerKey, region, encName, encTag, headers);
      if (!mmrV2Res.ok) {
        return res.status(200).json({ status: "error", chatMsg: `${displayUser}, ❌ Игрок не найден или ошибка сервера Riot.`, refund: true });
      }

      const j = mmrV2Res.data;
      if (String(j?.status) !== "200") {
        return res.status(200).json({ status: "error", chatMsg: `${displayUser}, ❌ Аккаунт не найден.`, refund: true });
      }

      const bySeason = j?.data?.by_season || {};
      const seasons = Object.keys(bySeason).filter(k => bySeason[k] && !bySeason[k].error);

      seasons.sort((a, b) => {
        const [eA, aA] = parseSeasonKey(a);
        const [eB, aB] = parseSeasonKey(b);
        if (eA !== eB) return eB - eA;
        return aB - aA;
      });

      let latestActKey = "";
      let totalGames = 0, wins = 0;

      if (seasons.length > 0) {
        latestActKey = seasons[0];
        totalGames = bySeason[latestActKey]?.number_of_games ?? 0;
        wins = bySeason[latestActKey]?.wins ?? 0;
      }

      if (totalGames === 0) {
        return res.status(200).json({ status: "empty", chatMsg: `${displayUser}, 🛌 В текущем акте ${name}#${tag} еще не играл в рейтинг!`, refund: true });
      }

      const losses = totalGames - wins;
      const globalWr = Math.round((wins / totalGames) * 100);
      const formattedAct = latestActKey.toUpperCase();
      const matchWord = getMatchWord(totalGames);

      const defaultMsg = `${displayUser}, 📊 (${name}#${tag}) ${formattedAct}: ${totalGames} ${matchWord} (${wins}W-${losses}L, ${globalWr}% WINRATE).`;
      const finalChatMsg = renderChatTpl(chatTpl, {
        user: displayUser,
        name, tag,
        act: formattedAct,
        games: totalGames,
        matchWord,
        w: wins,
        l: losses,
        wr: globalWr
      }, defaultMsg);

      return res.status(200).json({
        status: "ok",
        chatMsg: finalChatMsg,
        overlayData: {
          name, tag,
          act: formattedAct,
          totalGames,
          totalW: wins,
          totalL: losses,
          globalWr
        }
      });
    }

    return res.status(200).json({ status: "error", message: "Unknown action" });

  } catch (err) {
    return res.status(200).json({
      status: "error",
      chatMsg: `${displayUser}, ❌ Ошибка облачного сервера: ${err.message}`,
      refund: true
    });
  }
}

// =============================================================================
// ШАБЛОНИЗАТОР СООБЩЕНИЙ ЧАТА
// =============================================================================
function renderChatTpl(tpl, vars, fallback, maxLen = 490) {
  let out = (tpl && tpl.trim())
    ? tpl.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => (vars[key] !== undefined ? String(vars[key]) : match))
    : fallback;
  out = out.replace(/\s{2,}/g, " ").trim();
  if (out.length > maxLen) out = out.substring(0, maxLen - 5) + "...";
  return out;
}

// =============================================================================
// КЭШИРУЮЩИЙ СЛОЙ ДЛЯ HENRIKDEV API
// =============================================================================
function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    cache.delete(key);
    return null;
  }
  return entry.val;
}

function setCached(key, val, ttlMs) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { val, exp: Date.now() + ttlMs });
}

async function fetchJsonCached(cacheKey, url, headers, ttlMs) {
  const hit = getCached(cacheKey);
  if (hit) return hit;

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const p = (async () => {
    try {
      const resp = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!resp.ok) return { ok: false, status: resp.status, data: null };
      const data = await resp.json();
      const result = { ok: true, status: resp.status, data };
      setCached(cacheKey, result, ttlMs);
      return result;
    } catch {
      return { ok: false, status: 504, data: null };
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, p);
  return p;
}

function getAccount(playerKey, encName, encTag, headers) {
  return fetchJsonCached(`acc:${playerKey}`, `https://api.henrikdev.xyz/valorant/v1/account/${encName}/${encTag}`, headers, TTL.account);
}
function getMmrV3(playerKey, region, encName, encTag, headers) {
  return fetchJsonCached(`mmrv3:${playerKey}`, `https://api.henrikdev.xyz/valorant/v3/mmr/${region}/pc/${encName}/${encTag}`, headers, TTL.mmr);
}
function getMmrV2(playerKey, region, encName, encTag, headers) {
  return fetchJsonCached(`mmrv2:${playerKey}`, `https://api.henrikdev.xyz/valorant/v2/mmr/${region}/${encName}/${encTag}`, headers, TTL.season);
}
function getMmrHistory(playerKey, region, encName, encTag, headers) {
  return fetchJsonCached(`hist:${playerKey}`, `https://api.henrikdev.xyz/valorant/v1/mmr-history/${region}/${encName}/${encTag}`, headers, TTL.history);
}

async function getMatches(playerKey, region, encName, encTag, neededSize, headers) {
  const fullHit = getCached(`matches10:${playerKey}`);
  if (fullHit && fullHit.ok && Array.isArray(fullHit.data)) {
    return { ok: true, data: fullHit.data.slice(0, neededSize) };
  }

  const size = Math.min(Math.max(neededSize, 1), 10);
  const key = size === 10 ? `matches10:${playerKey}` : `matches${size}:${playerKey}`;
  const res = await fetchJsonCached(
    key,
    `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${encName}/${encTag}?size=${size}&mode=competitive`,
    headers,
    TTL.matches
  );

  if (!res.ok) return { ok: false, data: [] };
  const arr = Array.isArray(res.data?.data) ? res.data.data : [];
  if (size === 10) setCached(`matches10:${playerKey}`, { ok: true, data: arr }, TTL.matches);
  return { ok: true, data: arr };
}

async function getTopAgentFast(playerKey, region, name, tag, encName, encTag, headers) {
  const fullHit = getCached(`matches10:${playerKey}`);
  if (fullHit && fullHit.ok && Array.isArray(fullHit.data) && fullHit.data.length > 0) {
    return extractTopAgentFromV3(fullHit.data, name, tag);
  }

  const storedRes = await fetchJsonCached(
    `stored:${playerKey}`,
    `https://api.henrikdev.xyz/valorant/v1/stored-matches/${region}/${encName}/${encTag}?mode=competitive&size=10`,
    headers,
    TTL.stored
  );

  if (storedRes.ok && Array.isArray(storedRes.data?.data) && storedRes.data.data.length > 0) {
    const agentPlays = {};
    let games = 0;
    for (const m of storedRes.data.data) {
      games++;
      const rawChar = m?.stats?.character;
      const charStr = typeof rawChar === "string" ? rawChar : (rawChar?.name || "");
      if (charStr) {
        const clean = normalizeAgent(charStr);
        agentPlays[clean] = (agentPlays[clean] || 0) + 1;
      }
    }
    return { games, bestAgentName: pickTopAgent(agentPlays) };
  }

  const matchRes = await getMatches(playerKey, region, encName, encTag, 10, headers);
  if (matchRes.ok && Array.isArray(matchRes.data)) {
    return extractTopAgentFromV3(matchRes.data, name, tag);
  }

  return { games: 0, bestAgentName: "Unknown" };
}

// =============================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =============================================================================
function normalizeAgent(charName) {
  if (!charName) return "Unknown";
  return charName.toUpperCase() === "KAY/O" ? "KAYO" : charName;
}

function pickTopAgent(agentPlays) {
  let maxPlays = 0;
  let best = "Unknown";
  for (const [ag, count] of Object.entries(agentPlays)) {
    if (count > maxPlays) {
      maxPlays = count;
      best = ag;
    }
  }
  return best;
}

function extractTopAgentFromV3(mArr, name, tag) {
  const agentPlays = {};
  let games = 0;
  let targetPuuid = "";
  for (const m of mArr) {
    const players = m?.players?.all_players || [];
    const me = findPlayer(players, name, tag, targetPuuid);
    if (me) {
      targetPuuid = me.puuid || targetPuuid;
      games++;
      if (me.character) {
        const clean = normalizeAgent(me.character);
        agentPlays[clean] = (agentPlays[clean] || 0) + 1;
      }
    }
  }
  return { games, bestAgentName: pickTopAgent(agentPlays) };
}

function findPlayer(players, name, tag, puuid = "") {
  if (!Array.isArray(players)) return null;
  const nLow = name.toLowerCase();
  const tLow = tag.toLowerCase();
  for (const p of players) {
    if (puuid && p.puuid === puuid) return p;
    if ((p.name || "").toLowerCase() === nLow && (!tLow || (p.tag || "").toLowerCase() === tLow)) return p;
  }
  for (const p of players) {
    if ((p.name || "").toLowerCase() === nLow) return p;
  }
  return null;
}

function checkMVP(players, targetPlayer, myTeam) {
  let maxMatchScore = -1;
  let maxTeamScore = -1;
  const targetScore = targetPlayer?.stats?.score ?? 0;

  for (const p of players) {
    const s = p?.stats?.score ?? 0;
    const t = (p.team || "Red").toLowerCase();
    if (s > maxMatchScore) maxMatchScore = s;
    if (t === myTeam && s > maxTeamScore) maxTeamScore = s;
  }

  const isMatchMVP = targetScore === maxMatchScore && maxMatchScore !== -1;
  const isTeamMVP = targetScore === maxTeamScore && maxTeamScore !== -1 && !isMatchMVP;
  return { isMatchMVP, isTeamMVP };
}

function analyzeRounds(killsArr, targetPuuid) {
  let fb = 0, fd = 0, ace = 0, quad = 0, triple = 0, doubleKill = 0;
  if (!targetPuuid || !Array.isArray(killsArr)) {
    return { fb, fd, ace, quad, triple, doubleKill };
  }

  const processedRounds = new Set();
  const killsPerRound = {};

  for (const k of killsArr) {
    const rNum = k.round ?? -1;
    if (rNum !== -1 && !processedRounds.has(rNum)) {
      processedRounds.add(rNum);
      if (k.killer_puuid === targetPuuid) fb++;
      if (k.victim_puuid === targetPuuid) fd++;
    }
    if (rNum !== -1 && k.killer_puuid === targetPuuid) {
      killsPerRound[rNum] = (killsPerRound[rNum] || 0) + 1;
    }
  }

  for (const count of Object.values(killsPerRound)) {
    if (count >= 5) ace++;
    else if (count === 4) quad++;
    else if (count === 3) triple++;
    else if (count === 2) doubleKill++;
  }

  return { fb, fd, ace, quad, triple, doubleKill };
}

function parsePeak(jMMR) {
  let peakRank = jMMR?.data?.peak?.tier?.name || "Unranked";
  const peakId = jMMR?.data?.peak?.tier?.id ?? 0;
  const sea = jMMR?.data?.peak?.season?.short || "";
  let peakEp = "N/A";

  if (sea && sea.startsWith("e") && sea.includes("a")) {
    const parts = sea.split("a");
    const epStr = parts[0].replace("e", "");
    const actStr = parts[1];
    peakEp = `EP ${epStr} ACT ${actStr}`;
    const epNum = parseInt(epStr, 10) || 0;
    if (epNum > 0 && epNum < 5 && peakId >= 21) {
      if (peakId === 21) peakRank = "Immortal 1";
      else if (peakId === 22) peakRank = "Immortal 2";
      else if (peakId === 23) peakRank = "Immortal 3";
      else if (peakId === 24) peakRank = "Radiant";
    }
  }
  return { peakRank, peakEp };
}

function parseSeasonKey(key) {
  try {
    const parts = key.split("a");
    return [parseInt(parts[0].replace("e", ""), 10) || 0, parseInt(parts[1], 10) || 0];
  } catch {
    return [0, 0];
  }
}

function getMatchWord(count) {
  const r100 = count % 100;
  const r10 = count % 10;
  if (r100 >= 11 && r100 <= 19) return "матчей";
  if (r10 === 1) return "матч";
  if (r10 >= 2 && r10 <= 4) return "матча";
  return "матчей";
}
