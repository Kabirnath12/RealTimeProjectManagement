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

/*
 * CORS
 *
 * CLIENT_URL can contain multiple comma-separated origins.
 * Example:
 * CLIENT_URL=https://real-time-project-management.vercel.app,http://localhost:5173
 */
const allowedOrigins = [
  "http://localhost:5173",
  "https://real-time-project-management.vercel.app",
  ...(process.env.CLIENT_URL || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
];

const corsOptions: cors.CorsOptions = {
  origin: allowedOrigins,
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

app.use(cors(corsOptions));

app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST"]
  }
});

const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

type AuthUser = {
  id: string;
  email: string;
};

type AuthRequest = express.Request & {
  user?: AuthUser;
};

function auth(
  req: AuthRequest,
  res: express.Response,
  next: express.NextFunction
) {
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    return res.status(401).json({
      message: "Authentication required"
    });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET) as AuthUser;
    next();
  } catch {
    return res.status(401).json({
      message: "Invalid or expired token"
    });
  }
}

/*
 * Health
 */
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "project-management-api"
  });
});

/*
 * Register
 */
const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6)
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const data = registerSchema.parse(req.body);

    const email = data.email.toLowerCase();

    const exists = await prisma.user.findUnique({
      where: {
        email
      }
    });

    if (exists) {
      return res.status(409).json({
        message: "Email already registered"
      });
    }

    const passwordHash = await bcrypt.hash(
      data.password,
      10
    );

    const user = await prisma.user.create({
      data: {
        name: data.name,
        email,
        passwordHash
      }
    });

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email
      },
      JWT_SECRET,
      {
        expiresIn: "7d"
      }
    );

    return res.status(201).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    });
  } catch (e) {
    return res.status(400).json({
      message:
        e instanceof Error
          ? e.message
          : "Invalid request"
    });
  }
});

/*
 * Login
 */
app.post("/api/auth/login", async (req, res) => {
  try {
    const data = z
      .object({
        email: z.string().email(),
        password: z.string()
      })
      .parse(req.body);

    const user = await prisma.user.findUnique({
      where: {
        email: data.email.toLowerCase()
      }
    });

    if (
      !user ||
      !(await bcrypt.compare(
        data.password,
        user.passwordHash
      ))
    ) {
      return res.status(401).json({
        message: "Invalid email or password"
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email
      },
      JWT_SECRET,
      {
        expiresIn: "7d"
      }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    });
  } catch {
    return res.status(400).json({
      message: "Invalid request"
    });
  }
});

/*
 * Current user
 */
app.get(
  "/api/me",
  auth,
  async (req: AuthRequest, res) => {
    const user = await prisma.user.findUnique({
      where: {
        id: req.user!.id
      },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true
      }
    });

    return res.json(user);
  }
);

/*
 * Get workspaces
 */
app.get(
  "/api/workspaces",
  auth,
  async (req: AuthRequest, res) => {
    const userId = req.user!.id;

    const memberships =
      await prisma.workspaceMember.findMany({
        where: {
          userId
        },
        include: {
          workspace: true
        },
        orderBy: {
          workspace: {
            createdAt: "desc"
          }
        }
      });

    return res.json(
      memberships.map((membership) => ({
        ...membership.workspace,
        role: membership.role
      }))
    );
  }
);

/*
 * Create workspace
 */
app.post(
  "/api/workspaces",
  auth,
  async (req: AuthRequest, res) => {
    const userId = req.user!.id;

    const name = z
      .object({
        name: z.string().min(2)
      })
      .parse(req.body).name;

    const workspace =
      await prisma.workspace.create({
        data: {
          name,
          ownerId: userId,
          members: {
            create: {
              userId,
              role: "OWNER"
            }
          }
        }
      });

    return res.status(201).json(workspace);
  }
);

/*
 * Get projects in workspace
 */
app.get(
  "/api/workspaces/:workspaceId/projects",
  auth,
  async (req: AuthRequest, res) => {
    const workspaceId =
      req.params.workspaceId as string;

    const userId = req.user!.id;

    const membership =
      await prisma.workspaceMember.findFirst({
        where: {
          workspaceId,
          userId
        }
      });

    if (!membership) {
      return res.status(403).json({
        message: "Not a workspace member"
      });
    }

    const projects =
      await prisma.project.findMany({
        where: {
          workspaceId
        },
        include: {
          tasks: {
            orderBy: {
              position: "asc"
            }
          }
        },
        orderBy: {
          createdAt: "desc"
        }
      });

    return res.json(projects);
  }
);

/*
 * Create project
 */
app.post(
  "/api/workspaces/:workspaceId/projects",
  auth,
  async (req: AuthRequest, res) => {
    const workspaceId =
      req.params.workspaceId as string;

    const userId = req.user!.id;

    const membership =
      await prisma.workspaceMember.findFirst({
        where: {
          workspaceId,
          userId
        }
      });

    if (!membership) {
      return res.status(403).json({
        message: "Not a workspace member"
      });
    }

    const data = z
      .object({
        name: z.string().min(2),
        description: z.string().optional()
      })
      .parse(req.body);

    const project =
      await prisma.project.create({
        data: {
          name: data.name,
          description: data.description,
          workspaceId
        }
      });

    return res.status(201).json(project);
  }
);

/*
 * Create task
 */
app.post(
  "/api/projects/:projectId/tasks",
  auth,
  async (req: AuthRequest, res) => {
    const projectId =
      req.params.projectId as string;

    const userId = req.user!.id;

    const data = z
      .object({
        title: z.string().min(1),
        description: z.string().optional(),
        status: z
          .enum([
            "TODO",
            "IN_PROGRESS",
            "DONE"
          ])
          .default("TODO"),
        priority: z
          .enum([
            "LOW",
            "MEDIUM",
            "HIGH"
          ])
          .default("MEDIUM"),
        dueDate: z
          .string()
          .datetime()
          .optional()
      })
      .parse(req.body);

    const project =
      await prisma.project.findUnique({
        where: {
          id: projectId
        }
      });

    if (!project) {
      return res.status(404).json({
        message: "Project not found"
      });
    }

    const member =
      await prisma.workspaceMember.findFirst({
        where: {
          workspaceId: project.workspaceId,
          userId
        }
      });

    if (!member) {
      return res.status(403).json({
        message: "Not a workspace member"
      });
    }

    const task = await prisma.task.create({
      data: {
        title: data.title,
        description: data.description,
        status: data.status,
        priority: data.priority,
        projectId: project.id,
        dueDate: data.dueDate
          ? new Date(data.dueDate)
          : undefined
      }
    });

    io
      .to(`workspace:${project.workspaceId}`)
      .emit("task:created", task);

    return res.status(201).json(task);
  }
);

/*
 * Update task
 */
app.patch(
  "/api/tasks/:taskId",
  auth,
  async (req: AuthRequest, res) => {
    const taskId =
      req.params.taskId as string;

    const userId = req.user!.id;

    const data = z
      .object({
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        status: z
          .enum([
            "TODO",
            "IN_PROGRESS",
            "DONE"
          ])
          .optional(),
        priority: z
          .enum([
            "LOW",
            "MEDIUM",
            "HIGH"
          ])
          .optional(),
        position: z.number().int().optional()
      })
      .parse(req.body);

    const task =
      await prisma.task.findUnique({
        where: {
          id: taskId
        }
      });

    if (!task) {
      return res.status(404).json({
        message: "Task not found"
      });
    }

    const project =
      await prisma.project.findUnique({
        where: {
          id: task.projectId
        }
      });

    if (!project) {
      return res.status(404).json({
        message: "Project not found"
      });
    }

    const member =
      await prisma.workspaceMember.findFirst({
        where: {
          workspaceId: project.workspaceId,
          userId
        }
      });

    if (!member) {
      return res.status(403).json({
        message: "Not a workspace member"
      });
    }

    const updated =
      await prisma.task.update({
        where: {
          id: task.id
        },
        data
      });

    io
      .to(`workspace:${project.workspaceId}`)
      .emit("task:updated", updated);

    return res.json(updated);
  }
);

/*
 * Delete task
 */
app.delete(
  "/api/tasks/:taskId",
  auth,
  async (req: AuthRequest, res) => {
    const taskId =
      req.params.taskId as string;

    const userId = req.user!.id;

    const task =
      await prisma.task.findUnique({
        where: {
          id: taskId
        }
      });

    if (!task) {
      return res.status(404).json({
        message: "Task not found"
      });
    }

    const project =
      await prisma.project.findUnique({
        where: {
          id: task.projectId
        }
      });

    if (!project) {
      return res.status(404).json({
        message: "Project not found"
      });
    }

    const member =
      await prisma.workspaceMember.findFirst({
        where: {
          workspaceId: project.workspaceId,
          userId
        }
      });

    if (!member) {
      return res.status(403).json({
        message: "Not a workspace member"
      });
    }

    await prisma.task.delete({
      where: {
        id: task.id
      }
    });

    io
      .to(`workspace:${project.workspaceId}`)
      .emit("task:deleted", {
        id: task.id
      });

    return res.status(204).send();
  }
);

/*
 * Socket.IO authentication
 */
io.use((socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token;

    if (!token) {
      return next(
        new Error("Authentication required")
      );
    }

    socket.data.user = jwt.verify(
      token,
      JWT_SECRET
    );

    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

/*
 * Socket.IO connection
 */
io.on("connection", (socket) => {
  socket.on(
    "workspace:join",
    (workspaceId: string) => {
      socket.join(
        `workspace:${workspaceId}`
      );
    }
  );

  socket.on(
    "workspace:leave",
    (workspaceId: string) => {
      socket.leave(
        `workspace:${workspaceId}`
      );
    }
  );
});

/*
 * Error handler
 */
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(err);

    return res.status(500).json({
      message: "Internal server error"
    });
  }
);

/*
 * Start server
 */
server.listen(PORT, () => {
  console.log(
    `API running on http://localhost:${PORT}`
  );
});