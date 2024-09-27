import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { createUser, getUser, updateUser } from "../controllers/author.controller";

const router = express.Router();

const secret = process.env.JWT_SECRET || "secret";

router.post("/", async (req, res) => {
  //signup route authentification with prisma orm and bcrypt and json web token
  try {
    const { email, password, Name } = req.body;
    if (!email || !password || !Name) {
      return res
        .status(400)
        .json({ error: "Email, password and Name are required." });
    }

    const oldUser = await getUser(email);

    if (oldUser) {
      return res.status(409).send("User Already Exist. Please Login");
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const user = await createUser({ email, hashedPassword, Name });
    const token = jwt.sign({ userId: user.id }, secret, { expiresIn: '5h' });
    user.token = token;
    res.json(user);
    await updateUser(token, email);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error });
  }
});

export const signUpRoutes = router;
