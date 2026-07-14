module.exports = {
  apps: [
    {
      name: "pandoros",
      script: "server/index.js",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      out_file: "logs/out.log",
      error_file: "logs/err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
