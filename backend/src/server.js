const cors = require("cors");
const express = require("express");

const app = express();
const port = Number(process.env.PORT) || 3001;
const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

app.use(cors({ origin: frontendOrigin }));
app.use(express.json());

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`Express API listening at http://localhost:${port}`);
});
