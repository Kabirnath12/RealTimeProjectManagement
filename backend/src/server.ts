import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Server } from "socket.io";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_URL?.split(",") ?? "*", credentials: true }
});

app.use(cors({ origin: process.env.CLIENT_URL?.split(",") ?? "*", credentials: true }));
app.use(express.json());

const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

type AuthRequest = express.Request & { user?: { id: string; email: string } };

function auth(req: AuthRequest, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ message: "Authentication required" });
  try {
    req.user = jwt.verify(token, JWT_SECRET) as { id: string; email: string };
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6)
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "project-management-api" }));

app.post("/api/auth/register", async (req, res) => {
  try {
    const data = registerSchema.parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
    if (exists) return res.status(409).json({ message: "Email already registered" });
    const passwordHash = await bcrypt.hash(data.password, 10);
    const user = await prisma.user.create({
      data: { name: data.name, email: data.email.toLowerCase(), passwordHash }
    });
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    res.status(400).json({ message: e instanceof Error ? e.message : "Invalid request" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const data = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
    if (!user || !(await bcrypt.compare(data.password, user.passwordHash))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch {
    res.status(400).json({ message: "Invalid request" });
  }
});

app.get("/api/me", auth, async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { id: true, name: true, email: true, createdAt: true }
  });
  res.json(user);
});

app.get("/api/workspaces", auth, async (req: AuthRequest, res) => {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: req.user!.id },
    include: { workspace: true },
    orderBy: { workspace: { createdAt: "desc" } }
  });
  res.json(memberships.map(m => ({ ...m.workspace, role: m.role })));
});

app.post("/api/workspaces", auth, async (req: AuthRequest, res) => {
  const name = z.object({ name: z.string().min(2) }).parse(req.body).name;
  const workspace = await prisma.workspace.create({
    data: { name, ownerId: req.user!.id, members: { create: { userId: req.user!.id, role: "OWNER" } } }
  });
  res.status(201).json(workspace);
});

app.get("/api/workspaces/:workspaceId/projects", auth, async (req: AuthRequest, res) => {
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: req.params.workspaceId, userId: req.user!.id }
  });
  if (!membership) return res.status(403).json({ message: "Not a workspace member" });
  const projects = await prisma.project.findMany({
    where: { workspaceId: req.params.workspaceId },
    include: { tasks: { orderBy: { position: "asc" } } },
    orderBy: { createdAt: "desc" }
  });
  res.json(projects);
});

app.post("/api/workspaces/:workspaceId/projects", auth, async (req: AuthRequest, res) => {
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: req.params.workspaceId, userId: req.user!.id }
  });
  if (!membership) return res.status(403).json({ message: "Not a workspace member" });
  const data = z.object({ name: z.string().min(2), description: z.string().optional() }).parse(req.body);
  const project = await prisma.project.create({ data: { ...data, workspaceId: req.params.workspaceId } });
  res.status(201).json(project);
});

app.post("/api/projects/:projectId/tasks", auth, async (req: AuthRequest, res) => {
  const data = z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    status: z.enum(["TODO", "IN_PROGRESS", "DONE"]).default("TODO"),
    priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
    dueDate: z.string().datetime().optional()
  }).parse(req.body);
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (!project) return res.status(404).json({ message: "Project not found" });
  const member = await prisma.workspaceMember.findFirst({ where: { workspaceId: project.workspaceId, userId: req.user!.id } });
  if (!member) return res.status(403).json({ message: "Not a workspace member" });
  const task = await prisma.task.create({
    data: { ...data, projectId: project.id, dueDate: data.dueDate ? new Date(data.dueDate) : undefined }
  });
  io.to(`workspace:${project.workspaceId}`).emit("task:created", task);
  res.status(201).json(task);
});

app.patch("/api/tasks/:taskId", auth, async (req: AuthRequest, res) => {
  const data = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    status: z.enum(["TODO", "IN_PROGRESS", "DONE"]).optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
    position: z.number().int().optional()
  }).parse(req.body);
  const task = await prisma.task.findUnique({ where: { id: req.params.taskId }, include: { project: true } });
  if (!task) return res.status(404).json({ message: "Task not found" });
  const member = await prisma.workspaceMember.findFirst({ where: { workspaceId: task.project.workspaceId, userId: req.user!.id } });
  if (!member) return res.status(403).json({ message: "Not a workspace member" });
  const updated = await prisma.task.update({ where: { id: task.id }, data });
  io.to(`workspace:${task.project.workspaceId}`).emit("task:updated", updated);
  res.json(updated);
});

app.delete("/api/tasks/:taskId", auth, async (req: AuthRequest, res) => {
  const task = await prisma.task.findUnique({ where: { id: req.params.taskId }, include: { project: true } });
  if (!task) return res.status(404).json({ message: "Task not found" });
  const member = await prisma.workspaceMember.findFirst({ where: { workspaceId: task.project.workspaceId, userId: req.user!.id } });
  if (!member) return res.status(403).json({ message: "Not a workspace member" });
  await prisma.task.delete({ where: { id: task.id } });
  io.to(`workspace:${task.project.workspaceId}`).emit("task:deleted", { id: task.id });
  res.status(204).send();
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication required"));
    socket.data.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

io.on("connection", socket => {
  socket.on("workspace:join", (workspaceId: string) => socket.join(`workspace:${workspaceId}`));
  socket.on("workspace:leave", (workspaceId: string) => socket.leave(`workspace:${workspaceId}`));
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

server.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
