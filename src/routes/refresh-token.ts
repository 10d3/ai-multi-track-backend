import express from "express";
const jwt = require("jsonwebtoken");

const secret = process.env.JWT_SECRET || "secret";
const refreshTokenSecret = process.env.JWT_REFRESH_SECRET || "refreshSecret";
const refreshTokens: string[] = [];

const router = express.Router();
router.post('/api/refresh-token', (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(403).json({ message: 'Token de rafraîchissement requis' });
  }

  if (!refreshTokens.includes(token)) {
    return res.status(403).json({ message: 'Token invalide' });
  }

  try {
    const user = jwt.verify(token, refreshTokenSecret);
    const newAccessToken = jwt.sign({ id: user.id }, secret, { expiresIn: '5h' });
    res.json({ accessToken: newAccessToken });
  } catch (err) {
    return res.status(403).json({ message: 'Token de rafraîchissement invalide' });
  }
});

export const refreshTokenRoutes = router;