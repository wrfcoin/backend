function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function writeProbeResponse(req, res, serviceName, state = { draining: false }) {
  const path = req.url?.split('?')[0] || '/';

  if (path === '/health') {
    writeJson(res, state.draining ? 503 : 200, {
      status: state.draining ? 'draining' : 'healthy',
      service: serviceName,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      draining: state.draining,
    });
    return true;
  }

  if (path === '/ready') {
    writeJson(res, state.draining ? 503 : 200, {
      status: state.draining ? 'not_ready' : 'ready',
      service: serviceName,
      timestamp: new Date().toISOString(),
      draining: state.draining,
    });
    return true;
  }

  if (path === '/live') {
    writeJson(res, 200, {
      status: 'alive',
      service: serviceName,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    });
    return true;
  }

  return false;
}

module.exports = {
  writeProbeResponse,
};
