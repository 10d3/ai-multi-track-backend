import type { Application, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';
import dotenv from 'dotenv';
import cors from 'cors';

export function configureApp(app: Application) {
  dotenv.config();

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
  });

  const speedLimiter = slowDown({
    windowMs: 15 * 60 * 1000,
    delayAfter: 1,
    delayMs: () => 2000,
  });

  const corsOptions = {
    origin: 'http://localhost:3000', // Allow this specific origin
    methods: 'GET,POST,PUT,DELETE', // Allowed methods
    allowedHeaders: ['Content-Type', 'Authorization'], // Allowed headers, including 'Authorization'
  };

  app.use(cors(corsOptions));
  app.use(speedLimiter);
  app.use(limiter);

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept"
    );
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });
}
