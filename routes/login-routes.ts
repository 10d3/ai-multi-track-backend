import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import multer from "multer";
import path from "path";
import { exec } from "child_process";
import fs from "fs";
import { PrismaClient } from "@prisma/client/extension";
import { getUser, updateUser } from "../controllers/author.controller";

const router = express.Router();

const secret = process.env.JWT_SECRET || "secret";
router.post("/", async (req, res) => {
  //login route authentification with prisma orm and bcrypt and json web token
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email and password are required." });
    }

    const user = await getUser(email as string);
    if (!user) {
      return res.status(400).json({ error: "User not found." });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(400).json({ error: "Invalid password." });
    }

    const token = jwt.sign({ userId: user.id }, secret, { expiresIn: "5h" });
    res.json({ token });
    await updateUser(token, email);
  } catch (error) {
    res.status(500).json({ error: error });
  }
});

export const loginRoutes = router;
