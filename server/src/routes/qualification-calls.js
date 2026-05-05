import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// Liste des appels de qualification associés à une company.
router.get('/by-company/:companyId', (req, res) => {
  const rows = db.prepare(`
    SELECT
      id, airtable_record_id, company_id, company_name_raw, call_date, status, assignee,
      contact_full_name, contact_email, contact_phone,
      decision_maker_name, decision_maker_role,
      farm_description, has_employees, employees_count, is_charity, can_issue_charity_receipt,
      challenges, challenge_duration, challenge_financial_impact, short_term_goals,
      motivation_today, motivation_why_now, importance_score, readiness_score,
      has_budget, budget_amount, timeline,
      role_in_company, business_models, current_management, management_effective,
      pain_points, grows_tomatoes, tomato_season_months,
      summary, next_steps, notes,
      airtable_created_at, created_at, updated_at
    FROM qualification_calls
    WHERE company_id = ?
    ORDER BY COALESCE(call_date, airtable_created_at) DESC
  `).all(req.params.companyId)
  res.json({ data: rows })
})

export default router
