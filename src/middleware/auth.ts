const jwt = require("jsonwebtoken");
import type { Request, Response, NextFunction } from "express";

const secret = process.env.JWT_SECRET || "secret";

interface AuthenticatedRequest extends Request {
  user: any;
}
const verifyToken = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  // Récupérer le token dans le header Authorization en enlevant "Bearer"
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Supposer que le format est "Bearer <token>"

  // console.log("token", token);

  if (!token) {
    return res.status(403).send("A token is required for authentication");
  }

  try {
    const decoded = jwt.verify(token, secret);
    req.user = decoded;
  } catch (err) {
    return res.status(401).send("Invalid Token");
  }

  next();
};

module.exports = verifyToken;
