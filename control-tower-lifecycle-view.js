(function attachLifecycleView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ControlTowerLifecycleView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLifecycleView() {
  "use strict";

  const ROWS = Object.freeze([
    { key: "ESCALATED_TO_ADMIN", title: "Exceptions / Escalated-to-Admin", label: "Escalated to Admin", color: "#FFD6D6", description: "Administrator attention required" },
    { key: "WAITING_FOR_BUSINESS_HOURS", title: "Waiting for Business Hours", label: "Waiting for Business Hours", color: "#1F3A5F", description: "Held until the service window opens", dark: true },
    { key: "NEW", title: "New", label: "New", color: "#BFFBB6", description: "Initial response is pending" },
    { key: "REMINDER_SENT", title: "Reminder Sent", label: "Reminder Sent", color: "#D9EEFF", description: "A response reminder is active" },
    { key: "WAITING_FOR_OUTCOME_RESPONSE", title: "Waiting for Outcome Response", label: "Waiting for Outcome Response", color: "#E8E0FF", description: "A contact attempt needs an outcome" },
    { key: "AT_RISK", title: "At Risk", label: "At Risk", color: "#FFF0B8", description: "The final reminder window is active" }
  ]);

  const ROW_BY_KEY = new Map(ROWS.map(row => [row.key, row]));
  const DEFAULT_VIEW = "lifecycle";

  function buildLifecycleRows(leads, serviceWindow) {
    const visible = (Array.isArray(leads) ? leads : []).filter(lead => {
      return lead?.lifecycle?.presentation_ready === true &&
        lead.lifecycle.is_active !== false &&
        ROW_BY_KEY.has(lead.lifecycle.key);
    });

    return ROWS.map(row => {
      let items = visible.filter(lead => lead.lifecycle.key === row.key);
      if (row.key === "WAITING_FOR_BUSINESS_HOURS" && serviceWindow?.is_open === true) {
        items = [];
      }

      items.sort((left, right) => timestamp(left.received_ts_utc) - timestamp(right.received_ts_utc));
      return {
        ...row,
        items,
        empty_text: row.key === "WAITING_FOR_BUSINESS_HOURS" && serviceWindow?.is_open === true
          ? "Business hours are open. No leads are being held for release."
          : "No active leads in this stage."
      };
    });
  }

  function summaryItems(summary) {
    return [
      ["Active Leads", numberOrZero(summary?.active_leads)],
      ["At Risk", numberOrZero(summary?.at_risk)],
      ["Escalated to Admin", numberOrZero(summary?.escalated_to_admin)],
      ["Avg. Response Time", textOrFallback(summary?.avg_response_time?.display, "-")]
    ];
  }

  function buildAgentView(leads, agents, serviceWindow) {
    const visible = visibleLeads(leads);
    const escalated = oldestFirst(visible.filter(lead => lead.lifecycle.key === "ESCALATED_TO_ADMIN"));
    const held = oldestFirst(visible.filter(lead => lead.lifecycle.key === "WAITING_FOR_BUSINESS_HOURS"));
    const rows = [];

    if (escalated.length) {
      rows.push({
        type: "ADMINISTRATOR",
        key: "ADMINISTRATOR",
        title: "Administrator",
        description: "Escalated leads requiring administrator attention",
        items: escalated,
        metric: { label: "Escalated Leads", value: escalated.length }
      });
    }

    if (serviceWindow?.is_open === true) {
      const normalLeads = visible.filter(lead => {
        return lead.lifecycle.key !== "ESCALATED_TO_ADMIN" &&
          lead.lifecycle.key !== "WAITING_FOR_BUSINESS_HOURS" &&
          String(lead.assigned_agent?.agent_id || "").trim();
      });

      (Array.isArray(agents) ? agents : []).forEach(agent => {
        const agentId = String(agent?.agent_id || "").trim();
        if (!agentId) return;
        const items = oldestFirst(normalLeads.filter(lead => String(lead.assigned_agent?.agent_id || "").trim() === agentId));
        if (!items.length) return;
        rows.push({
          type: "AGENT",
          key: agentId,
          title: textOrFallback(agent.agent_name, agentId),
          initials: textOrFallback(agent.initials, initialsForName(agent.agent_name)),
          photo_url: textOrFallback(agent.photo_url, null),
          items,
          avg_response_time: textOrFallback(agent.avg_response_time?.display, "-"),
          explicit_reassignments_today: numberOrZero(agent.explicit_reassignments_today)
        });
      });
    } else if (held.length) {
      rows.push({
        type: "WAITING_QUEUE",
        key: "WAITING_FOR_BUSINESS_HOURS",
        title: "Waiting for Business Hours",
        description: "Held until the service window opens",
        items: held
      });
    }

    return {
      rows,
      waiting_indicator: serviceWindow?.is_open === true
        ? "Waiting for Business Hours: empty"
        : null
    };
  }

  function cardClassFor(key) {
    return ROW_BY_KEY.has(key) ? `lead-card lifecycle-${key.toLowerCase().replaceAll("_", "-")}` : "lead-card";
  }

  function cardPresentation(lead, mode = "lifecycle") {
    return {
      lead_name: textOrFallback(lead?.lead_name, "Lead"),
      phone_display: textOrFallback(lead?.phone_display, null),
      received_display: textOrFallback(lead?.received_display, null),
      lifecycle_label: textOrFallback(lead?.lifecycle?.label, null),
      assigned_agent_name: mode === "lifecycle" && lead?.assigned_agent?.agent_id
        ? textOrFallback(lead.assigned_agent.agent_name, null)
        : null
    };
  }

  function carouselState({ scrollLeft = 0, clientWidth = 0, scrollWidth = 0 } = {}) {
    const max = Math.max(0, scrollWidth - clientWidth - 1);
    return {
      show_left: scrollLeft > 1,
      show_right: scrollLeft < max
    };
  }

  function timestamp(value) {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  }

  function visibleLeads(leads) {
    return (Array.isArray(leads) ? leads : []).filter(lead => {
      return lead?.lifecycle?.presentation_ready === true &&
        lead.lifecycle.is_active !== false &&
        ROW_BY_KEY.has(lead.lifecycle.key);
    });
  }

  function oldestFirst(leads) {
    return leads.slice().sort((left, right) => timestamp(left.received_ts_utc) - timestamp(right.received_ts_utc));
  }

  function initialsForName(value) {
    return String(value || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0].toUpperCase())
      .join("") || "--";
  }

  function numberOrZero(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function textOrFallback(value, fallback) {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  return { DEFAULT_VIEW, ROWS, buildAgentView, buildLifecycleRows, cardClassFor, cardPresentation, carouselState, summaryItems };
});
