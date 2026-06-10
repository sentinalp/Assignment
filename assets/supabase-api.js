(function () {
  const SYSTEMS = ["KFC", "NONKFC"];
  const APP_TZ = "Asia/Bangkok";
  const OFFLINE_BEFORE_END_MINUTES = 15;
  const BREAK_BEFORE_START_MINUTES = 15;
  const END_TIME_RESET_HOUR = 5;
  const END_TIME_RESET_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  let lastEndTimeResetCheck = 0;

  const config = window.APP_CONFIG || {};
  const missingConfig =
    !config.SUPABASE_URL ||
    !config.SUPABASE_ANON_KEY ||
    config.SUPABASE_URL.includes("YOUR_PROJECT_ID") ||
    config.SUPABASE_ANON_KEY.includes("YOUR_SUPABASE_ANON_KEY");

  const db = missingConfig || !window.supabase
    ? null
    : window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);

  function assertReady() {
    if (!db) {
      throw new Error("Supabase ยังไม่ได้ตั้งค่า: แก้ไฟล์ assets/app-config.js ก่อนใช้งาน");
    }
  }

  function thaiDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: APP_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      hour12: false
    }).formatToParts(date);
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }

  function todayInThailand() {
    const p = thaiDateParts();
    return `${p.year}-${p.month}-${p.day}`;
  }

  function getThailandMinutesOfDay() {
    const p = thaiDateParts();
    return Number(p.hour) * 60 + Number(p.minute);
  }

  function toWorkdayMinutes(minutes) {
    return minutes < END_TIME_RESET_HOUR * 60 ? minutes + 24 * 60 : minutes;
  }

  function parseTimeToMinutes(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour === 24 && minute === 0) return 24 * 60;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
  }

  function formatEndTime(value) {
    return String(value || "").trim();
  }

  function getFirstName(value) {
    return String(value || "").trim().split(/\s+/)[0] || "";
  }

  function parseReportDate(dateText) {
    if (!dateText) return todayInThailand();
    const text = String(dateText).trim();
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return text;
    const th = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (th) return `${th[3]}-${String(th[2]).padStart(2, "0")}-${String(th[1]).padStart(2, "0")}`;
    const fallback = new Date(text);
    if (Number.isNaN(fallback.getTime())) return todayInThailand();
    return fallback.toISOString().slice(0, 10);
  }

  function isSameDate(dateValue, dateKey) {
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return false;
    const p = thaiDateParts(date);
    return `${p.year}-${p.month}-${p.day}` === dateKey;
  }

  function formatQueueTime(dateValue) {
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString();
  }

  async function requireAdmin(username) {
    const { data, error } = await db
      .from("users")
      .select("user_group")
      .eq("username", username)
      .maybeSingle();
    if (error) throw error;
    if (String(data?.user_group || "user").toLowerCase() !== "admin") {
      throw new Error("Admin permission required");
    }
    return true;
  }

  async function orderedAgents(system) {
    assertReady();
    const { data, error } = await db
      .from("agents")
      .select(`
   	 id,
   	 name,
   	 status,
   	 note,
    	end_time,
    	break_time,
    	full_name,
    	position
  `)
      .eq("system", system)
      .order("position", { ascending: true })
      .order("name", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function getLastAssignedAgentId(system) {
    assertReady();
    const { data, error } = await db
      .from("queue")
      .select("agent_id")
      .eq("system", system)
      .order("assigned_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data?.agent_id || null;
  }

  async function cleanupOldQueueHistory() {
    assertReady();
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 1);
    const { error } = await db
      .from("queue")
      .delete()
      .lt("assigned_at", cutoff.toISOString());
    if (error) console.warn("Queue history cleanup failed", error);
  }

  async function resetEndTimesIfNeeded() {
    assertReady();
    const now = Date.now();
    if (now - lastEndTimeResetCheck < END_TIME_RESET_CHECK_INTERVAL_MS) return;
    lastEndTimeResetCheck = now;

    const { error } = await db.rpc("reset_agent_end_times_if_needed");
    if (error) {
      console.warn("Agent end time reset check failed", error);
    }
  }

  function getNextAgent(agents, lastId) {
    if (!agents.length) return null;
    const index = agents.findIndex((agent) => String(agent.id) === String(lastId));
    return index < 0 ? agents[0] : agents[(index + 1) % agents.length];
  }

  async function applyEndTimeCutoff(system) {
    await resetEndTimesIfNeeded();
    const agents = await orderedAgents(system);
    const nowMinutes = toWorkdayMinutes(getThailandMinutesOfDay());
    const offlineUpdates = agents
      .filter((agent) => {
        const endMinutes = parseTimeToMinutes(agent.end_time);
        if (String(agent.status).toUpperCase() !== "ONLINE" || endMinutes === null) return false;
        return nowMinutes >= toWorkdayMinutes(endMinutes) - OFFLINE_BEFORE_END_MINUTES;
      })
      .map((agent) => agent.id);

    const breakUpdates = agents
      .filter((agent) => {
        const breakMinutes = parseTimeToMinutes(agent.break_time);
        if (String(agent.status).toUpperCase() !== "ONLINE" || breakMinutes === null) return false;
        return nowMinutes >= toWorkdayMinutes(breakMinutes) - BREAK_BEFORE_START_MINUTES;
      })
      .map((agent) => agent.id)
      .filter((id) => !offlineUpdates.includes(id));

    if (offlineUpdates.length) {
      const { error } = await db
        .from("agents")
        .update({ status: "OFFLINE", updated_at: new Date().toISOString() })
        .eq("system", system)
        .in("id", offlineUpdates);
      if (error) throw error;
    }

    if (breakUpdates.length) {
      const { error } = await db
        .from("agents")
        .update({ status: "BREAK", updated_at: new Date().toISOString() })
        .eq("system", system)
        .in("id", breakUpdates);
      if (error) throw error;
    }
  }

  async function getAssignmentCountsByAgent(system, reportDate) {
    const dateKey = parseReportDate(reportDate || todayInThailand());
    const { data, error } = await db
      .from("queue")
      .select("agent_name, assigned_at")
      .eq("system", system)
      .gte("assigned_at", `${dateKey}T00:00:00+07:00`)
      .lt("assigned_at", `${dateKey}T23:59:59.999+07:00`);
    if (error) throw error;
    const counts = {};
    (data || []).forEach((row) => {
      const agent = String(row.agent_name || "").trim();
      if (agent && isSameDate(row.assigned_at, dateKey)) counts[agent] = (counts[agent] || 0) + 1;
    });
    return counts;
  }

  async function getAgents(system) {
    await applyEndTimeCutoff(system);
    const rows = await orderedAgents(system);
    const counts = await getAssignmentCountsByAgent(system);
    const agents = rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status || "OFFLINE",
      note: row.note || "",
      endTime: formatEndTime(row.end_time),
      breakTime: formatEndTime(row.break_time),
      fullName: row.full_name || "",
      todayCount: counts[String(row.name || "").trim()] || 0
    }));
    const queueMap = await getQueueOrderMap(system, agents);
    return agents.map((agent) => ({ ...agent, queueNo: queueMap[String(agent.id)] || "" }));
  }

  async function getQueueOrderMap(system, agents) {
    const onlineAgents = agents.filter((agent) => agent.status === "ONLINE");
    if (!onlineAgents.length) return {};
    const last = await getLastAssignedAgentId(system);
    const next = getNextAgent(onlineAgents, last);
    const nextIndex = next
      ? onlineAgents.findIndex((agent) => String(agent.id) === String(next.id))
      : 0;
    const ordered = onlineAgents.slice(nextIndex).concat(onlineAgents.slice(0, nextIndex));
    return Object.fromEntries(ordered.map((agent, index) => [String(agent.id), index + 1]));
  }

  async function saveAgentPositions(system, rows) {
    const payload = rows.map((row, index) => ({
      system,
      id: row.id,
      name: row.name,
      status: row.status || "OFFLINE",
      note: row.note || "",
      end_time: row.end_time || "",
      break_time: row.break_time || "",
      full_name: row.full_name || "",
      position: index + 1,
      updated_at: new Date().toISOString()
    }));
    const { error } = await db.from("agents").upsert(payload, { onConflict: "system,id" });
    if (error) throw error;
  }

  async function moveAgentToNextQueue(system, id) {
    const rows = await orderedAgents(system);
    if (rows.length < 2) return;
    const sourceIndex = rows.findIndex((row) => String(row.id) === String(id));
    if (sourceIndex < 0) return;
    const source = rows.splice(sourceIndex, 1)[0];
    const lastAssignedId = await getLastAssignedAgentId(system);
    const lastAssignedIndex = rows.findIndex(
      (row) => String(row.id) === String(lastAssignedId) && String(row.status).toUpperCase() === "ONLINE"
    );
    rows.splice(lastAssignedIndex >= 0 ? lastAssignedIndex + 1 : 0, 0, source);
    await saveAgentPositions(system, rows);
  }

  async function checkLogin(user, pass) {
    assertReady();
    const { data, error } = await db
      .from("users")
      .select("username, password, user_group")
      .eq("username", String(user))
      .eq("password", String(pass))
      .maybeSingle();
    if (error) throw error;
    if (!data) return { success: false };
    return {
      success: true,
      user: data.username,
      group: String(data.user_group || "user").toLowerCase()
    };
  }

  async function toggleAgent(id, system) {
    const agents = await orderedAgents(system);
    const agent = agents.find((row) => String(row.id) === String(id));
    if (!agent) return undefined;
    const newStatus = agent.status === "ONLINE" ? "OFFLINE" : "ONLINE";
    const patch = {
      status: newStatus,
      updated_at: new Date().toISOString()
    };
    if (newStatus === "ONLINE") patch.break_time = "";
    const { error } = await db
      .from("agents")
      .update(patch)
      .eq("system", system)
      .eq("id", id);
    if (error) throw error;
    if (newStatus === "ONLINE") await moveAgentToNextQueue(system, id);
    return newStatus;
  }

  async function toggleBreak(id, system) {
    const agents = await orderedAgents(system);
    const agent = agents.find((row) => String(row.id) === String(id));
    if (!agent) return undefined;
    const newStatus = agent.status === "BREAK" ? "ONLINE" : "BREAK";
    const patch = {
      status: newStatus,
      updated_at: new Date().toISOString()
    };
    if (newStatus === "ONLINE") patch.break_time = "";
    const { error } = await db
      .from("agents")
      .update(patch)
      .eq("system", system)
      .eq("id", id);
    if (error) throw error;
    if (newStatus === "ONLINE") await moveAgentToNextQueue(system, id);
    return newStatus;
  }

  async function updateAgentNote(id, note, system) {
    const { error } = await db
      .from("agents")
      .update({ note: note || "", updated_at: new Date().toISOString() })
      .eq("system", system)
      .eq("id", id);
    if (error) throw error;
    return "OK";
  }

  async function updateAgentEndTime(id, endTime, system) {
    const cleanEndTime = formatEndTime(endTime);
    if (cleanEndTime && parseTimeToMinutes(cleanEndTime) === null) {
      throw new Error("Invalid end time");
    }
    const { error } = await db
      .from("agents")
      .update({ end_time: cleanEndTime, updated_at: new Date().toISOString() })
      .eq("system", system)
      .eq("id", id);
    if (error) throw error;
    await applyEndTimeCutoff(system);
    return "OK";
  }

  async function updateAgentBreakTime(id, breakTime, system) {
    const cleanBreakTime = formatEndTime(breakTime);
    if (cleanBreakTime && parseTimeToMinutes(cleanBreakTime) === null) {
      throw new Error("Invalid break time");
    }
    const { error } = await db
      .from("agents")
      .update({ break_time: cleanBreakTime, updated_at: new Date().toISOString() })
      .eq("system", system)
      .eq("id", id);
    if (error) throw error;
    await applyEndTimeCutoff(system);
    return "OK";
  }

  async function getNextInQueue(system) {
    const agents = (await getAgents(system)).filter((agent) => agent.status === "ONLINE");
    if (!agents.length) return null;
    const last = await getLastAssignedAgentId(system);
    return getNextAgent(agents, last);
  }

  async function assignTicket(ticket, system, manualAgentId, user) {
    assertReady();
    if (!ticket) return { ok: false, message: "No ticket" };
    await applyEndTimeCutoff(system);

    const agents = await getAgents(system);
    let selected = null;
    let mode = "AUTO";

    if (manualAgentId) {
      selected = agents.find((agent) => String(agent.id) === String(manualAgentId));
      if (selected) mode = "MANUAL";
    }

    if (!selected) {
      const onlineAgents = agents.filter((agent) => agent.status === "ONLINE");
      if (!onlineAgents.length) return { ok: false, message: "No online agent" };
      const last = await getLastAssignedAgentId(system);
      selected = getNextAgent(onlineAgents, last);
    }

    const { error } = await db.from("queue").insert({
      system,
      ticket,
      agent_id: selected.id,
      agent_name: selected.name,
      mode,
      assigned_by: user || ""
    });
    if (error) throw error;

    return {
      ok: true,
      id: selected.id,
      name: selected.name,
      copyName: getFirstName(selected.fullName || selected.name),
      mode
    };
  }

  async function getLastQueue(system) {
    assertReady();
    const { data, error } = await db
      .from("queue")
      .select("id, ticket, agent_name, assigned_at, mode, assigned_by")
      .eq("system", system)
      .order("assigned_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(4);
    if (error) throw error;
    return (data || []).map((row) => ({
      ticket: row.ticket,
      agent: row.agent_name,
      time: row.assigned_at,
      mode: row.mode,
      user: row.assigned_by,
      row: row.id
    }));
  }

  async function deleteLastTicket(system) {
    const { data, error } = await db
      .from("queue")
      .select("id")
      .eq("system", system)
      .order("assigned_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return false;
    const deleted = await db.from("queue").delete().eq("id", data.id);
    if (deleted.error) throw deleted.error;
    return true;
  }

  async function getReportData(reportDate) {
    assertReady();
    const dateKey = parseReportDate(reportDate);
    const result = { dateKey, systems: {} };

    await Promise.all(SYSTEMS.map(async (system) => {
      const { data, error } = await db
        .from("queue")
        .select("agent_name, assigned_at, assigned_by")
        .eq("system", system)
        .gte("assigned_at", `${dateKey}T00:00:00+07:00`)
        .lt("assigned_at", `${dateKey}T23:59:59.999+07:00`);
      if (error) throw error;

      const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
      const byAgentMap = {};
      const byUserMap = {};
      let total = 0;

      (data || []).forEach((row) => {
        if (!isSameDate(row.assigned_at, dateKey)) return;
        const date = new Date(row.assigned_at);
        const hour = Number(thaiDateParts(date).hour);
        const agent = String(row.agent_name || "").trim();
        const user = String(row.assigned_by || "-").trim() || "-";
        hourly[hour].count++;
        byAgentMap[agent] = (byAgentMap[agent] || 0) + 1;
        byUserMap[user] = (byUserMap[user] || 0) + 1;
        total++;
      });

      result.systems[system] = {
        total,
        sheetName: "queue",
        skippedRows: 0,
        hourly,
        byAgent: Object.keys(byAgentMap)
          .map((name) => ({ name, count: byAgentMap[name] }))
          .sort((a, b) => b.count - a.count),
        byUser: Object.keys(byUserMap)
          .map((name) => ({ name, count: byUserMap[name] }))
          .sort((a, b) => b.count - a.count)
      };
    }));

    return result;
  }

  async function getAssignmentHistory(historyDate, searchText) {
    const dateKey = parseReportDate(historyDate || todayInThailand());
    const query = String(searchText || "").trim().toLowerCase();
    const rows = [];

    await Promise.all(SYSTEMS.map(async (system) => {
      const { data, error } = await db
        .from("queue")
	.select("id, ticket, agent_id, agent_name, assigned_at, mode, assigned_by")
	.eq("system", system)
	.gte("assigned_at", `${dateKey}T00:00:00+07:00`)
	.lt("assigned_at", `${dateKey}T23:59:59.999+07:00`)
	.order("assigned_at", { ascending: false })
	.limit(200)
      if (error) throw error;

      (data || []).forEach((row) => {
        const searchable = `${row.ticket || ""} ${row.agent_name || ""}`.toLowerCase();
        if (query && !searchable.includes(query)) return;
        rows.push({
          system,
          ticket: row.ticket,
          agentId: row.agent_id,
          agent: row.agent_name,
          time: new Date(row.assigned_at),
          mode: row.mode,
          user: row.assigned_by,
          row: row.id
        });
      });
    }));

    rows.sort((a, b) => b.time.getTime() - a.time.getTime());
    return {
      dateKey,
      total: rows.length,
      rows: rows.map((row) => ({
        ...row,
        time: formatQueueTime(row.time)
      }))
    };
  }

  async function getTodaySummary(system) {
    const report = await getReportData();
    return report.systems[system]?.byAgent || [];
  }

  async function getAdminAgents(username) {
    await requireAdmin(username);
    const result = {};
    await Promise.all(SYSTEMS.map(async (system) => {
      result[system] = await getAgents(system);
    }));
    return result;
  }

  async function saveAgentAdmin(username, system, agent) {
    await requireAdmin(username);
    const id = agent.id || `AG${Date.now()}`;
    const endTime = formatEndTime(agent.endTime);
    const rows = await orderedAgents(system);
    const current = rows.find((row) => String(row.id) === String(id));
    const breakTime = formatEndTime(agent.breakTime || current?.break_time || "");
    if (endTime && parseTimeToMinutes(endTime) === null) throw new Error("Invalid end time");
    if (breakTime && parseTimeToMinutes(breakTime) === null) throw new Error("Invalid break time");
    const { error } = await db.from("agents").upsert({
      system,
      id,
      name: agent.name || "",
      status: agent.status || "OFFLINE",
      note: agent.note || "",
      end_time: endTime,
      break_time: breakTime,
      full_name: agent.fullName || current?.full_name || "",
      position: current?.position || rows.length + 1,
      updated_at: new Date().toISOString()
    }, { onConflict: "system,id" });
    if (error) throw error;
    return { ok: true, id };
  }

  async function deleteAgentAdmin(username, system, id) {
    await requireAdmin(username);
    const { error } = await db.from("agents").delete().eq("system", system).eq("id", id);
    if (error) throw error;
    return true;
  }

  async function getUsersAdmin(username) {
    await requireAdmin(username);
    const { data, error } = await db
      .from("users")
      .select("username, password, user_group")
      .order("username", { ascending: true });
    if (error) throw error;
    return (data || []).map((row) => ({
      username: row.username,
      password: row.password,
      group: String(row.user_group || "user").toLowerCase()
    }));
  }

  async function saveUserAdmin(username, userData) {
    await requireAdmin(username);
    if (!userData.username) throw new Error("Username required");
    const { error } = await db.from("users").upsert({
      username: userData.username,
      password: userData.password || "",
      user_group: String(userData.group || "user").toLowerCase(),
      updated_at: new Date().toISOString()
    }, { onConflict: "username" });
    if (error) throw error;
    return { ok: true };
  }

  async function deleteUserAdmin(username, targetUsername) {
    await requireAdmin(username);
    if (String(username) === String(targetUsername)) {
      throw new Error("Cannot delete current user");
    }
    const { error } = await db.from("users").delete().eq("username", targetUsername);
    if (error) throw error;
    return true;
  }

  window.WorkAssignmentApi = {
    checkLogin,
    getAgents,
    toggleAgent,
    toggleBreak,
    updateAgentNote,
    updateAgentEndTime,
    updateAgentBreakTime,
    getNextInQueue,
    assignTicket,
    getLastQueue,
    deleteLastTicket,
    getReportData,
    getAssignmentHistory,
    getTodaySummary,
    getAdminAgents,
    saveAgentAdmin,
    deleteAgentAdmin,
    getUsersAdmin,
    saveUserAdmin,
    deleteUserAdmin
  };

  function createRunner(successHandler, failureHandler) {
    return new Proxy({}, {
      get(_target, prop) {
        if (prop === "withSuccessHandler") {
          return (handler) => createRunner(handler, failureHandler);
        }
        if (prop === "withFailureHandler") {
          return (handler) => createRunner(successHandler, handler);
        }
        return (...args) => {
          const fn = window.WorkAssignmentApi[prop];
          if (!fn) {
            const err = new Error(`Function not found: ${String(prop)}`);
            if (failureHandler) failureHandler(err);
            else console.error(err);
            return;
          }
          Promise.resolve()
            .then(() => fn(...args))
            .then((result) => {
              if (successHandler) successHandler(result);
            })
            .catch((err) => {
              if (failureHandler) failureHandler(err);
              else {
                console.error(err);
                alert(err.message || err);
              }
            });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = createRunner();
})();
