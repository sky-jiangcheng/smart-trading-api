const app = require("../index");

module.exports = (req, res) => {
  if (req.url && req.url.startsWith("/api/")) {
    req.url = req.url.slice(4) || "/";
  }

  return app(req, res);
};
