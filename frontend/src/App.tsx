import { useEffect, useMemo, useState } from "react";
import { io, Socket } from "socket.io-client";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000/api";
const SOCKET = import.meta.env.VITE_SOCKET_URL || "http://localhost:5000";

type User = { id: string; name: string; email: string };
type Workspace = { id: string; name: string; role: string };
type Task = { id: string; title: string; description?: string; status: "TODO"|"IN_PROGRESS"|"DONE"; priority: "LOW"|"MEDIUM"|"HIGH"; position: number };
type Project = { id: string; name: string; description?: string; tasks: Task[] };

async function request(path: string, options: RequestInit = {}, token?: string) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Request failed");
  return res.status === 204 ? null : res.json();
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("token") || "");
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [register, setRegister] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState("");
  const [newProject, setNewProject] = useState("");
  const [newTask, setNewTask] = useState("");
  const [error, setError] = useState("");
  const [socket, setSocket] = useState<Socket | null>(null);

  const columns = useMemo(() => ({
    TODO: project?.tasks.filter(t => t.status === "TODO") || [],
    IN_PROGRESS: project?.tasks.filter(t => t.status === "IN_PROGRESS") || [],
    DONE: project?.tasks.filter(t => t.status === "DONE") || []
  }), [project]);

  useEffect(() => {
    if (!token) return;
    request("/me", {}, token).then(setUser).catch(() => logout());
    request("/workspaces", {}, token).then((items: Workspace[]) => { setWorkspaces(items); if (items[0]) setWorkspace(items[0]); }).catch(e => setError(e.message));
    const s = io(SOCKET, { auth: { token } });
    s.on("task:created", (task: Task) => setProject(p => p ? {...p, tasks: [...p.tasks, task]} : p));
    s.on("task:updated", (task: Task) => setProject(p => p ? {...p, tasks: p.tasks.map(t => t.id === task.id ? task : t)} : p));
    s.on("task:deleted", ({id}: {id: string}) => setProject(p => p ? {...p, tasks: p.tasks.filter(t => t.id !== id)} : p));
    setSocket(s);
    return () => { s.disconnect(); };
  }, [token]);

  useEffect(() => {
    if (!workspace || !token) return;
    request(`/workspaces/${workspace.id}/projects`, {}, token).then((items: Project[]) => { setProjects(items); setProject(items[0] || null); });
    socket?.emit("workspace:join", workspace.id);
    return () => { socket?.emit("workspace:leave", workspace.id); };
  }, [workspace, token, socket]);

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault(); setError("");
    try {
      const data = register
        ? await request("/auth/register", { method: "POST", body: JSON.stringify({ name, email, password }) })
        : await request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      localStorage.setItem("token", data.token); setToken(data.token); setUser(data.user);
    } catch (e) { setError(e instanceof Error ? e.message : "Authentication failed"); }
  }

  function logout() { localStorage.removeItem("token"); setToken(""); setUser(null); setSocket(null); }

  async function createWorkspace() {
    if (!newWorkspace.trim()) return;
    const item = await request("/workspaces", { method: "POST", body: JSON.stringify({ name: newWorkspace }) }, token);
    setWorkspaces([item, ...workspaces]); setWorkspace(item); setNewWorkspace("");
  }

  async function createProject() {
    if (!workspace || !newProject.trim()) return;
    const item = await request(`/workspaces/${workspace.id}/projects`, { method: "POST", body: JSON.stringify({ name: newProject }) }, token);
    const full = {...item, tasks: []}; setProjects([full, ...projects]); setProject(full); setNewProject("");
  }

  async function createTask() {
    if (!project || !newTask.trim()) return;
    const task = await request(`/projects/${project.id}/tasks`, { method: "POST", body: JSON.stringify({ title: newTask, priority: "MEDIUM" }) }, token);
    setProject({...project, tasks: [...project.tasks, task]}); setNewTask("");
  }

  async function moveTask(task: Task, status: Task["status"]) {
    if (task.status === status) return;
    const updated = await request(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ status }) }, token);
    setProject(p => p ? {...p, tasks: p.tasks.map(t => t.id === task.id ? updated : t)} : p);
  }

  if (!token) return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submitAuth}>
        <div className="brand">FlowBoard</div>
        <h1>{register ? "Create your workspace" : "Welcome back"}</h1>
        <p>Real-time project management for focused teams.</p>
        {register && <input placeholder="Full name" value={name} onChange={e => setName(e.target.value)} />}
        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
        <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required />
        {error && <div className="error">{error}</div>}
        <button>{register ? "Create account" : "Sign in"}</button>
        <button type="button" className="ghost" onClick={() => setRegister(!register)}>
          {register ? "Already have an account? Sign in" : "Create a new account"}
        </button>
      </form>
    </div>
  );

  return (
    <div className="app-shell">
      <aside>
        <div className="brand">FlowBoard</div>
        <div className="muted">WORKSPACES</div>
        <div className="workspace-list">
          {workspaces.map(w => <button className={workspace?.id === w.id ? "nav active" : "nav"} key={w.id} onClick={() => setWorkspace(w)}>{w.name}</button>)}
        </div>
        <div className="inline-create"><input placeholder="New workspace" value={newWorkspace} onChange={e => setNewWorkspace(e.target.value)} /><button onClick={createWorkspace}>+</button></div>
        <div className="muted">PROJECTS</div>
        {projects.map(p => <button className={project?.id === p.id ? "nav active" : "nav"} key={p.id} onClick={() => setProject(p)}>{p.name}</button>)}
        <div className="inline-create"><input placeholder="New project" value={newProject} onChange={e => setNewProject(e.target.value)} /><button onClick={createProject}>+</button></div>
        <div className="sidebar-bottom">
          <div><strong>{user?.name}</strong><small>{user?.email}</small></div>
          <button className="ghost" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <main>
        <header>
          <div><span className="eyebrow">PROJECT MANAGEMENT</span><h1>{project?.name || "Your workspace"}</h1><p>{project?.description || "Plan, prioritize and ship work together."}</p></div>
          <div className="live"><span /> Live</div>
        </header>

        {!project ? <div className="empty"><h2>Start your first project</h2><p>Create a workspace and project from the sidebar.</p></div> :
        <section>
          <div className="toolbar"><input value={newTask} onChange={e => setNewTask(e.target.value)} onKeyDown={e => e.key === "Enter" && createTask()} placeholder="Add a task and press Enter..." /><button onClick={createTask}>Add task</button></div>
          <div className="board">
            {(["TODO","IN_PROGRESS","DONE"] as const).map(status => (
              <div className="column" key={status} onDragOver={e => e.preventDefault()} onDrop={e => { const id = e.dataTransfer.getData("task"); const t = project.tasks.find(x => x.id === id); if (t) moveTask(t, status); }}>
                <div className="column-title"><span>{status === "TODO" ? "To do" : status === "IN_PROGRESS" ? "In progress" : "Done"}</span><b>{columns[status].length}</b></div>
                {columns[status].map(task => (
                  <article className="task" draggable key={task.id} onDragStart={e => e.dataTransfer.setData("task", task.id)}>
                    <div className={`priority ${task.priority.toLowerCase()}`}>{task.priority}</div>
                    <h3>{task.title}</h3>
                    {task.description && <p>{task.description}</p>}
                    <small>Updated {new Date().toLocaleDateString()}</small>
                  </article>
                ))}
              </div>
            ))}
          </div>
        </section>}
      </main>
    </div>
  );
}
