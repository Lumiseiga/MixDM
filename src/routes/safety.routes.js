const express = require('express');
const reportsDb = require('../../reports-db');
const { requireDeveloper } = require('../middleware/auth.middleware');
const { checkReportRateLimit } = require('../middleware/rateLimit.middleware');

const router = express.Router();

// GET /api/developer/reports
router.get('/developer/reports', requireDeveloper, (req, res) => {
  const type = req.query.type;
  const reports = reportsDb.getReports(type);
  res.json({ success: true, reports });
});

// DELETE /api/developer/reports
router.delete('/developer/reports', requireDeveloper, (req, res) => {
  const ok = reportsDb.clearReports();
  if (ok) {
    res.json({ success: true, message: 'ล้างประวัติรายงานทั้งหมดเรียบร้อยแล้ว (All reports cleared)' });
  } else {
    res.status(500).json({ success: false, error: 'ไม่สามารถลบรายงานได้ (Failed to clear reports)' });
  }
});

// POST /api/report/bug
router.post('/report/bug', (req, res) => {
  if (!checkReportRateLimit(req.ip)) {
    return res.status(429).json({ success: false, error: 'ส่งรายงานถี่เกินไป กรุณารอสักครู่ (Too many reports, please wait)' });
  }
  const { title, description, steps, appVersion, platform, senderName, senderEmail } = req.body;
  if (!title || !description) {
    return res.status(400).json({ success: false, error: 'กรุณากรอกหัวข้อและรายละเอียด (Title and description are required)' });
  }
  const report = reportsDb.saveReport('bug', { title, description, steps, appVersion, platform, senderName, senderEmail });
  res.json({ success: true, reportId: report.id, message: 'ขอบคุณที่รายงานปัญหา เราจะตรวจสอบโดยเร็ว (Bug report received)' });
});

// POST /api/report/crash
router.post('/report/crash', (req, res) => {
  if (!checkReportRateLimit(req.ip)) {
    return res.status(429).json({ success: false, error: 'ส่งรายงานถี่เกินไป กรุณารอสักครู่ (Too many reports, please wait)' });
  }
  const { errorMessage, stackTrace, appVersion, platform, senderName, senderEmail } = req.body;
  if (!errorMessage) {
    return res.status(400).json({ success: false, error: 'กรุณากรอกข้อมูล error (Error message is required)' });
  }
  const report = reportsDb.saveReport('crash', { errorMessage, stackTrace, appVersion, platform, senderName, senderEmail });
  res.json({ success: true, reportId: report.id, message: 'บันทึก crash report เรียบร้อยแล้ว (Crash report received)' });
});

// POST /api/report/security
router.post('/report/security', (req, res) => {
  if (!checkReportRateLimit(req.ip)) {
    return res.status(429).json({ success: false, error: 'ส่งรายงานถี่เกินไป กรุณารอสักครู่ (Too many reports, please wait)' });
  }
  const { title, detail, appVersion, platform, senderName, senderEmail } = req.body;
  if (!title || !detail) {
    return res.status(400).json({ success: false, error: 'กรุณากรอกข้อมูลให้ครบ (Title and detail are required)' });
  }
  const report = reportsDb.saveReport('security', { title, detail, appVersion, platform, senderName, senderEmail });
  res.json({ success: true, reportId: report.id, message: 'บันทึก security report เรียบร้อยแล้ว (Security report received)' });
});

module.exports = router;
