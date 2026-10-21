-- Layer 2 Enterprise Feedback Collection Database Schema
-- PostgreSQL schema for comprehensive feedback collection system

-- Feedback Surveys Table
CREATE TABLE IF NOT EXISTS feedback_surveys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    survey_type VARCHAR(50) NOT NULL CHECK (survey_type IN ('performance', 'integration', 'usability', 'general')),
    version VARCHAR(20) NOT NULL DEFAULT '1.0',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Feedback Questions Table
CREATE TABLE IF NOT EXISTS feedback_questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    survey_id UUID REFERENCES feedback_surveys(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    question_type VARCHAR(50) NOT NULL CHECK (question_type IN ('rating', 'text', 'multiple-choice', 'boolean', 'numeric')),
    is_required BOOLEAN DEFAULT false,
    question_order INTEGER NOT NULL,
    options JSONB, -- For multiple choice options
    validation_rules JSONB, -- Min/max values, patterns, etc.
    conditional_logic JSONB, -- Conditional display logic
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Feedback Sessions Table
CREATE TABLE IF NOT EXISTS feedback_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_id VARCHAR(255) NOT NULL,
    partner_name VARCHAR(255) NOT NULL,
    session_type VARCHAR(50) NOT NULL CHECK (session_type IN ('performance-testing', 'integration-testing', 'general-experience', 'post-deployment')),
    survey_id UUID REFERENCES feedback_surveys(id),
    test_scenario_id VARCHAR(255),
    start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired')),
    metadata JSONB, -- Test environment, TPS targets, duration, etc.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Feedback Responses Table
CREATE TABLE IF NOT EXISTS feedback_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES feedback_sessions(id) ON DELETE CASCADE,
    question_id UUID REFERENCES feedback_questions(id) ON DELETE CASCADE,
    partner_id VARCHAR(255) NOT NULL,
    response_value JSONB NOT NULL, -- Flexible storage for different response types
    response_context JSONB, -- Test phase, performance metrics, error logs
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Partner Satisfaction Metrics Table
CREATE TABLE IF NOT EXISTS partner_satisfaction_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_id VARCHAR(255) NOT NULL,
    partner_name VARCHAR(255) NOT NULL,
    metric_type VARCHAR(50) NOT NULL, -- 'nps', 'csat', 'ces', etc.
    score DECIMAL(3,2) NOT NULL,
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    sample_size INTEGER DEFAULT 1,
    calculated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Feedback Analytics Aggregates Table
CREATE TABLE IF NOT EXISTS feedback_analytics_aggregates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(50) NOT NULL, -- 'daily', 'weekly', 'monthly'
    metric_name VARCHAR(100) NOT NULL, -- 'avg_satisfaction', 'response_rate', etc.
    metric_value DECIMAL(10,4) NOT NULL,
    dimensions JSONB, -- Partner type, survey type, etc.
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    calculated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Survey Triggers Table
CREATE TABLE IF NOT EXISTS survey_triggers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    survey_id UUID REFERENCES feedback_surveys(id) ON DELETE CASCADE,
    trigger_type VARCHAR(50) NOT NULL, -- 'post-test', 'milestone', 'error', 'time-based', 'manual'
    trigger_conditions JSONB NOT NULL, -- Conditions for when to trigger
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Feedback Insights Table (for ML/analytics insights)
CREATE TABLE IF NOT EXISTS feedback_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insight_type VARCHAR(50) NOT NULL, -- 'trend', 'anomaly', 'recommendation'
    title VARCHAR(255) NOT NULL,
    description TEXT,
    severity VARCHAR(20) DEFAULT 'info' CHECK (severity IN ('critical', 'warning', 'info')),
    data_sources JSONB, -- Related sessions, responses, metrics
    insights_data JSONB, -- Structured insight data
    action_items JSONB, -- Recommended actions
    status VARCHAR(20) DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'in-progress', 'resolved')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_feedback_sessions_partner_id ON feedback_sessions(partner_id);
CREATE INDEX IF NOT EXISTS idx_feedback_sessions_session_type ON feedback_sessions(session_type);
CREATE INDEX IF NOT EXISTS idx_feedback_sessions_status ON feedback_sessions(status);
CREATE INDEX IF NOT EXISTS idx_feedback_sessions_created_at ON feedback_sessions(created_at);

CREATE INDEX IF NOT EXISTS idx_feedback_responses_session_id ON feedback_responses(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_responses_partner_id ON feedback_responses(partner_id);
CREATE INDEX IF NOT EXISTS idx_feedback_responses_submitted_at ON feedback_responses(submitted_at);

CREATE INDEX IF NOT EXISTS idx_feedback_questions_survey_id ON feedback_questions(survey_id);
CREATE INDEX IF NOT EXISTS idx_feedback_questions_order ON feedback_questions(question_order);

CREATE INDEX IF NOT EXISTS idx_partner_satisfaction_partner_id ON partner_satisfaction_metrics(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_satisfaction_period ON partner_satisfaction_metrics(period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_analytics_aggregates_type_metric ON feedback_analytics_aggregates(aggregate_type, metric_name);
CREATE INDEX IF NOT EXISTS idx_analytics_aggregates_period ON feedback_analytics_aggregates(period_start, period_end);

-- Triggers for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_feedback_sessions_updated_at 
    BEFORE UPDATE ON feedback_sessions 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_feedback_surveys_updated_at 
    BEFORE UPDATE ON feedback_surveys 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_feedback_insights_updated_at 
    BEFORE UPDATE ON feedback_insights 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Sample surveys and questions data
INSERT INTO feedback_surveys (name, description, survey_type, version) VALUES 
('Layer 2 Performance Testing Experience', 'Comprehensive feedback on Layer 2 performance testing experience', 'performance', '1.0'),
('Enterprise Integration Experience', 'Feedback on the enterprise integration process and support', 'integration', '1.0'),
('General Platform Satisfaction', 'Overall satisfaction with the Layer 2 platform and services', 'general', '1.0');

-- Sample questions for performance testing survey
INSERT INTO feedback_questions (survey_id, question_text, question_type, is_required, question_order, options, validation_rules) 
VALUES 
(
    (SELECT id FROM feedback_surveys WHERE name = 'Layer 2 Performance Testing Experience'),
    'How would you rate the overall performance testing experience?',
    'rating',
    true,
    1,
    '{"scale": "1-5", "labels": ["Very Poor", "Poor", "Average", "Good", "Excellent"]}',
    '{"min": 1, "max": 5}'
),
(
    (SELECT id FROM feedback_surveys WHERE name = 'Layer 2 Performance Testing Experience'),
    'How satisfied are you with the achieved transaction throughput (TPS)?',
    'rating',
    true,
    2,
    '{"scale": "1-5", "labels": ["Very Dissatisfied", "Dissatisfied", "Neutral", "Satisfied", "Very Satisfied"]}',
    '{"min": 1, "max": 5}'
),
(
    (SELECT id FROM feedback_surveys WHERE name = 'Layer 2 Performance Testing Experience'),
    'What was the actual TPS achieved during your testing?',
    'numeric',
    false,
    3,
    null,
    '{"min": 0, "max": 1000000}'
),
(
    (SELECT id FROM feedback_surveys WHERE name = 'Layer 2 Performance Testing Experience'),
    'Did you encounter any technical issues during testing?',
    'boolean',
    true,
    4,
    null,
    null
),
(
    (SELECT id FROM feedback_surveys WHERE name = 'Layer 2 Performance Testing Experience'),
    'What specific areas need improvement? (Select all that apply)',
    'multiple-choice',
    false,
    5,
    '["Documentation", "API Usability", "Performance Consistency", "Error Handling", "Support Response", "Test Environment Stability"]',
    null
),
(
    (SELECT id FROM feedback_surveys WHERE name = 'Layer 2 Performance Testing Experience'),
    'Please provide any additional comments or suggestions for improvement.',
    'text',
    false,
    6,
    null,
    '{"maxLength": 1000}'
),
(
    (SELECT id FROM feedback_surveys WHERE name = 'Layer 2 Performance Testing Experience'),
    'How likely are you to recommend our Layer 2 solution to other organizations? (0-10)',
    'numeric',
    true,
    7,
    null,
    '{"min": 0, "max": 10}'
);

-- Sample survey triggers
INSERT INTO survey_triggers (survey_id, trigger_type, trigger_conditions) VALUES
(
    (SELECT id FROM feedback_surveys WHERE name = 'Layer 2 Performance Testing Experience'),
    'post-test',
    '{"test_completion": true, "min_duration_minutes": 10}'
),
(
    (SELECT id FROM feedback_surveys WHERE name = 'Enterprise Integration Experience'),
    'milestone',
    '{"integration_status": "completed", "auto_trigger": true}'
),
(
    (SELECT id FROM feedback_surveys WHERE name = 'General Platform Satisfaction'),
    'time-based',
    '{"frequency": "monthly", "day_of_month": 1}'
);

-- Comments for documentation
COMMENT ON TABLE feedback_surveys IS 'Master table for feedback survey templates';
COMMENT ON TABLE feedback_questions IS 'Individual questions within surveys with validation rules';
COMMENT ON TABLE feedback_sessions IS 'Active feedback collection sessions linked to testing activities';
COMMENT ON TABLE feedback_responses IS 'Individual responses to survey questions';
COMMENT ON TABLE partner_satisfaction_metrics IS 'Calculated satisfaction metrics over time periods';
COMMENT ON TABLE feedback_analytics_aggregates IS 'Pre-calculated analytics for reporting dashboards';
COMMENT ON TABLE survey_triggers IS 'Automated triggers for survey deployment';
COMMENT ON TABLE feedback_insights IS 'AI/ML generated insights and recommendations from feedback data';