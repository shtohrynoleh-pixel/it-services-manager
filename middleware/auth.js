// Authentication middleware

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  return res.redirect('/login');
}

function requireCompanyAccess(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/login');
  const user = req.session.user;
  const companyId = parseInt(req.params.companyId || req.query.company_id || req.body.company_id);

  // Admin can access any company
  if (user.role === 'admin') return next();

  // Client can only access their own company
  if (user.company_id && user.company_id === companyId) return next();

  return res.status(403).send('Access denied');
}

module.exports = { requireLogin, requireAdmin, requireCompanyAccess };
