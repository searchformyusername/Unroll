import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileJson2,
  Folder,
  MoreHorizontal,
  Pencil,
  Trash2,
  FolderOpen,
} from "lucide-react";
import {
  groupTogether,
  moveToGroup,
  readGroups,
  removeFromGroups,
  type Group,
} from "./groups";
type NavRun = { id: string; name: string; bytes: number };
const KEY = "unroll-groups-v1";
const size = (n: number) =>
  n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
export default function TrajectoryList({
  runs,
  activeId,
  ready,
  canPrune,
  onSelect,
  onRemove,
  onNotice,
  onRename,
}: {
  runs: NavRun[];
  activeId?: string;
  ready: boolean;
  canPrune: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onNotice: (text: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [groups, setGroups] = useState<Group[]>(() => {
      try {
        return readGroups(localStorage.getItem(KEY));
      } catch {
        return [];
      }
    }),
    [editing, setEditing] = useState<string | null>(null),
    [draft, setDraft] = useState(""),
    [closed, setClosed] = useState<Set<string>>(new Set()),
    [over, setOver] = useState(""),
    [menu, setMenu] = useState<string | null>(null);
  const rename = useRef<HTMLInputElement>(null);
  const fileRename = useRef<HTMLInputElement>(null);
  const [editingRun, setEditingRun] = useState<string | null>(null),
    [fileDraft, setFileDraft] = useState("");
  const suppressClick = useRef(false);
  const cancelGroupRename = useRef(false),
    cancelFileRename = useRef(false);
  const [ghost, setGhost] = useState<{
    x: number;
    y: number;
    name: string;
  } | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(groups));
    } catch {
      onNotice("Group changes could not be saved in browser storage.");
    }
  }, [groups]);
  useEffect(() => {
    if (editing) {
      rename.current?.focus();
      rename.current?.select();
    }
  }, [editing]);
  useEffect(() => {
    if (!canPrune) return;
    const ids = new Set(runs.map((r) => r.id));
    setGroups((prev) => {
      const next = prev
        .map((g) => ({ ...g, runIds: g.runIds.filter((id) => ids.has(id)) }))
        .filter((g) => g.runIds.length);
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
  }, [runs, canPrune]);
  useEffect(() => {
    if (editingRun) {
      fileRename.current?.focus();
      fileRename.current?.select();
    }
  }, [editingRun]);
  function finishFileRename() {
    if (cancelFileRename.current) return;
    if (editingRun && fileDraft.trim())
      onRename(editingRun, fileDraft.trim().slice(0, 120));
    setEditingRun(null);
  }
  const grouped = new Set(groups.flatMap((g) => g.runIds));
  function beginRename(group: Group) {
    cancelGroupRename.current = false;
    setDraft(group.name);
    setEditing(group.id);
    setMenu(null);
  }
  function commitRename() {
    if (cancelGroupRename.current || !editing) return;
    const name = draft.trim().slice(0, 80);
    if (name)
      setGroups((prev) =>
        prev.map((g) => (g.id === editing ? { ...g, name } : g)),
      );
    setEditing(null);
  }
  function combine(source: string, target: string) {
    if (!runs.some((r) => r.id === source) || source === target) return;
    const result = groupTogether(groups, source, target, crypto.randomUUID());
    setGroups(result.groups);
    setOver("");
    setMenu(null);
    if (result.createdId) {
      const group = result.groups.find((g) => g.id === result.createdId)!;
      setClosed((prev) => {
        const next = new Set(prev);
        next.delete(group.id);
        return next;
      });
      beginRename(group);
    }
  }
  function source(e: React.DragEvent) {
    return e.dataTransfer.getData("application/x-unroll-run");
  }
  function accept(e: React.DragEvent, id: string) {
    if (e.dataTransfer.types.includes("application/x-unroll-run")) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setOver(id);
    }
  }
  function beginDrag(e: React.PointerEvent, id: string) {
    if (e.button !== 0) return;
    const startX = e.clientX,
      startY = e.clientY;
    let moved = false;
    e.currentTarget.setPointerCapture(e.pointerId);
    const hit = (x: number, y: number) =>
      document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-run-id],[data-group-id],[data-ungroup]");
    const move = (event: PointerEvent) => {
      if (
        !moved &&
        Math.hypot(event.clientX - startX, event.clientY - startY) < 7
      )
        return;
      moved = true;
      suppressClick.current = true;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      setGhost({
        x: event.clientX + 12,
        y: event.clientY + 12,
        name: runs.find((r) => r.id === id)?.name || "Trajectory",
      });
      const target = hit(event.clientX, event.clientY);
      setOver(
        target?.dataset.runId ||
          target?.dataset.groupId ||
          (target?.hasAttribute("data-ungroup") ? "ungrouped" : ""),
      );
    };
    const finish = (event: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (moved) {
        const target = hit(event.clientX, event.clientY);
        if (target?.dataset.runId) combine(id, target.dataset.runId);
        else if (target?.dataset.groupId) {
          const groupId = target.dataset.groupId;
          setGroups((prev) => moveToGroup(prev, id, groupId));
          setClosed((prev) => {
            const next = new Set(prev);
            next.delete(groupId);
            return next;
          });
        } else if (target?.hasAttribute("data-ungroup"))
          setGroups((prev) => removeFromGroups(prev, id));
        setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      }
      setGhost(null);
      setOver("");
    };
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      suppressClick.current = false;
      setGhost(null);
      setOver("");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  }
  function row(run: NavRun, inGroup?: Group) {
    return (
      <div
        key={run.id}
        className={`run-item ${activeId === run.id ? "active" : ""} ${over === run.id ? "drop-target" : ""}`}
        data-run-id={run.id}
        draggable={false}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-unroll-run", run.id);
          e.dataTransfer.effectAllowed = "move";
          setMenu(null);
        }}
        onDragEnd={() => setOver("")}
        onDragOver={(e) => accept(e, run.id)}
        onDragLeave={() => setOver("")}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const id = source(e);
          if (id) combine(id, run.id);
          setOver("");
        }}
      >
        {editingRun === run.id ? (
          <input
            ref={fileRename}
            className="file-rename"
            aria-label="Trajectory name"
            value={fileDraft}
            maxLength={120}
            onChange={(e) => setFileDraft(e.target.value)}
            onBlur={finishFileRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                finishFileRename();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancelFileRename.current = true;
                setEditingRun(null);
              }
            }}
          />
        ) : (
          <button
            className="run-select"
            draggable={false}
            onPointerDown={(e) => beginDrag(e, run.id)}
            onClick={() => {
              if (!suppressClick.current) onSelect(run.id);
            }}
          >
            <FileJson2 size={16} />
            <span>
              <strong title={run.name}>{run.name}</strong>
              <small>{size(run.bytes)}</small>
            </span>
          </button>
        )}
        <button
          className="run-menu-button icon-button"
          aria-label={`Options for ${run.name}`}
          onClick={() => setMenu(menu === run.id ? null : run.id)}
        >
          <MoreHorizontal size={14} />
        </button>
        {menu === run.id && (
          <div className="run-menu">
            <button
              onClick={() => {
                cancelFileRename.current = false;
                setEditingRun(run.id);
                setFileDraft(run.name);
                setMenu(null);
              }}
            >
              <Pencil size={13} />
              Rename trajectory
            </button>
            <label>
              Move to group
              <select
                aria-label={`Group for ${run.name}`}
                value={inGroup?.id || ""}
                onChange={(e) => {
                  setGroups((prev) =>
                    e.target.value
                      ? moveToGroup(prev, run.id, e.target.value)
                      : removeFromGroups(prev, run.id),
                  );
                  setMenu(null);
                }}
              >
                <option value="">Ungrouped</option>
                {groups.map((g) => (
                  <option value={g.id} key={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Group with
              <select
                aria-label={`Group ${run.name} with another trajectory`}
                value=""
                onChange={(e) => combine(run.id, e.target.value)}
              >
                <option value="" disabled>
                  Choose a trajectory…
                </option>
                {runs
                  .filter((r) => r.id !== run.id)
                  .map((r) => (
                    <option value={r.id} key={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              onClick={() => {
                setMenu(null);
                onRemove(run.id);
              }}
            >
              <Trash2 size={13} />
              Remove trajectory
            </button>
            <button className="menu-close" onClick={() => setMenu(null)}>
              Close
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      <div
        data-ungroup
        className={`list-label ${over === "ungrouped" ? "drop-target" : ""}`}
        onDragOver={(e) => accept(e, "ungrouped")}
        onDragLeave={() => setOver("")}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const id = source(e);
          if (id) setGroups((prev) => removeFromGroups(prev, id));
          setOver("");
        }}
      >
        Trajectories <span>{runs.length}</span>
      </div>
      <nav className="run-list" aria-label="Loaded trajectories">
        {!ready && <span className="nav-empty">Loading…</span>}
        {ready && !runs.length && (
          <span className="nav-empty">No files loaded</span>
        )}
        {groups.map((group) => (
          <section
            data-group-id={group.id}
            className={`trajectory-group ${over === group.id ? "drop-target" : ""}`}
            key={group.id}
            onDragOver={(e) => accept(e, group.id)}
            onDragLeave={() => setOver("")}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const id = source(e);
              if (id && runs.some((r) => r.id === id)) {
                setGroups((prev) => moveToGroup(prev, id, group.id));
                setClosed((prev) => {
                  const next = new Set(prev);
                  next.delete(group.id);
                  return next;
                });
              }
              setOver("");
            }}
          >
            <div className="group-header">
              {editing === group.id ? (
                <>
                  <Folder size={14} />
                  <input
                    ref={rename}
                    aria-label="Group name"
                    value={draft}
                    maxLength={80}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        cancelGroupRename.current = true;
                        setEditing(null);
                      }
                    }}
                  />
                </>
              ) : (
                <button
                  className="group-toggle"
                  aria-expanded={!closed.has(group.id)}
                  onClick={() =>
                    setClosed((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.id)) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    })
                  }
                >
                  {closed.has(group.id) ? (
                    <ChevronRight size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )}
                  <Folder size={14} />
                  <span>{group.name}</span>
                  <small>{group.runIds.length}</small>
                </button>
              )}
              <button
                className="icon-button"
                aria-label={`Options for ${group.name}`}
                onClick={() => setMenu(menu === group.id ? null : group.id)}
              >
                <MoreHorizontal size={13} />
              </button>
              {menu === group.id && (
                <div className="group-menu">
                  <button onClick={() => beginRename(group)}>
                    <Pencil size={13} />
                    Rename group
                  </button>
                  <button
                    onClick={() => {
                      setGroups((prev) =>
                        prev.filter((g) => g.id !== group.id),
                      );
                      setMenu(null);
                    }}
                  >
                    <FolderOpen size={13} />
                    Ungroup files
                  </button>
                  <button onClick={() => setMenu(null)}>Close</button>
                </div>
              )}
            </div>
            {!closed.has(group.id) && (
              <div className="group-runs">
                {group.runIds
                  .map((id) => runs.find((r) => r.id === id))
                  .filter((r): r is NavRun => !!r)
                  .map((r) => row(r, group))}
              </div>
            )}
          </section>
        ))}
        {runs.filter((r) => !grouped.has(r.id)).map((r) => row(r))}
      </nav>
      {ghost && (
        <div className="drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <FileJson2 size={14} />
          {ghost.name}
        </div>
      )}
    </>
  );
}
