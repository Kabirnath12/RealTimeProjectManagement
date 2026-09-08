# Real-Time Project Management System

A full-stack project management application with authentication, workspaces, projects, Kanban tasks, comments, activity tracking, and Socket.IO-ready real-time architecture.

## Stack
- Frontend: React + TypeScript + Vite
- Styling: Tailwind CSS
- Backend: Node.js + Express + TypeScript
- Database: PostgreSQL + Prisma
- Real-time: Socket.IO
- Auth: JWT + bcrypt
- Deployment: Vercel + Render

## Structure
- `frontend/` React application
- `backend/` Express API
- `prisma/` database schema

## Local setup

### Backend
```bash
cd backend
npm install
copy .env.example .env
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

### Frontend
```bash
cd frontend
npm install
copy .env.example .env
npm run dev
```

Backend defaults to `http://localhost:5000`.
Frontend defaults to `http://localhost:5173`.

See the `.env.example` files for required variables.
