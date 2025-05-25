const UserController = require("../../controllers/user/UserController");
const expectRoute = require("./expectedRoutes");

async function authMiddleware(req, res, next) {
  console.log("Requested path:", req.path);

  const isTokenPresent =
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) ||
    (req.cookies && req.cookies.__session);

  const isPathMatched = expectRoute.some(route => 
    typeof route === 'string' ? route === req.path : route.test(req.path)
  );

  if (!isTokenPresent && isPathMatched) {
    return next();
  }

  const idToken = getIdToken(req);

  if (!idToken) {
    return res.status(401).json({ status: 401, message: "Authorization token is missing" });
  }

  try {
    req.user = await UserController.findByToken(idToken);
    return next();
  } catch (error) {
    console.error("Token validation error:", error);
    return res.status(401).json({ status: 401, message: "Invalid authorization token" });
  }
}

function getIdToken(req) {
  if (req.headers.authorization) {
    return req.headers.authorization.split('Bearer ')[1];
  } 
  if (req.cookies) {
    return req.cookies.__session;
  }
  return null;
}

module.exports = { authMiddleware };