export interface Actor {
  tenant_id: string;
  tenant_name: string;
  base_currency: string;
  default_location?: string | null;
  default_language?: string;
  tenant_external_search_enabled: boolean;
  server_external_search_enabled: boolean;
  effective_external_search_enabled: boolean;
  user_id: string;
  email: string;
  display_name: string;
  title: string;
  roles: string[];
  approval_limit_usd: string | null;
}

export interface Persona {
  id: string;
  tenant_id: string;
  tenant_name: string;
  user_id: string;
  display_name: string;
  title: string;
  roles_label: string;
}

export interface SupplierItem {
  id: string;
  name: string;
  category: string;
  contact_email: string | null;
  phone: string | null;
  location: string | null;
  website_url: string | null;
  source_url: string | null;
  verification_status: string;
  notes: string | null;
}

export interface ExtractedSupplierCandidate {
  supplier_name: string;
  website_url: string;
  source_url: string;
  contact_email: string | null;
  phone: string | null;
  location: string | null;
  matched_products: string[];
  notes: string;
  retrieved_at: string;
  verification_status: string;
}

export interface RfqEmailDraft {
  supplier_id: string;
  supplier_name: string;
  recipient_email: string | null;
  phone: string | null;
  website_url: string | null;
  subject: string;
  body: string;
  mailto_url: string;
  has_email: boolean;
}

export interface ReactStep {
  step: number;
  max_steps: number;
  thought: string;
  action: string;
  observation: string;
  status: string;
}

export interface ExternalLead {
  title: string;
  url: string;
  domain?: string;
  snippet: string;
  found_emails?: string[];
  found_phones?: string[];
  retrieved_at: string;
  verification_status: string;
}

export interface SpecItemVerdict {
  spec: string;
  status: "pass" | "needs_clarification" | "fail";
  evidence: string;
}

export interface SpecVerification {
  request_version?: number;
  quote_revision?: number;
  overall_status: "pass" | "needs_clarification" | "fail";
  summary_reason: string;
  specs?: SpecItemVerdict[];
  requested_router?: string | null;
  verified_by_model?: string | null;
  provider?: string | null;
  cache_hit?: boolean;
  cost_usd?: string | null;
  human_override?: {
    status: string;
    reason: string;
    editor_name: string;
    quote_revision: number;
  } | null;
}

export interface RunSummary {
  run_id: string;
  thread_id: string;
  request_id: string;
  reference_code: string | null;
  title: string | null;
  phase: string;
  status: string;
  pending_decision_id: string | null;
  created_at: string;
}

export interface ComparisonOffer {
  quotation_id: string;
  quote_code: string;
  revision_number: number;
  supplier_id: string;
  supplier_name: string;
  supplier_verification_status: string;
  currency_code: string;
  quantity: number;
  unit_price: string;
  item_subtotal: string;
  discount_amount: string;
  freight_amount: string | null;
  quoted_tax_amount: string | null;
  fiscal_stamp_amount?: string | null;
  total_quoted_cost: string | null;
  budget_headroom: string | null;
  delivery_days: number | null;
  warranty_months: number | null;
  payment_terms: string;
  meets_mandatory_specs: boolean;
  spec_verification?: SpecVerification | null;
  source_filename: string;
  eligibility: "eligible" | "ineligible" | "needs_clarification";
  failure_reasons: string[];
  missing_cost_components: string[];
  is_recommended: boolean;
  corrections_count: number;
}

export interface WorkspaceData {
  request: {
    id: string;
    reference_code: string;
    title: string;
    status: string;
    current_version: number;
    currency_code: string;
    location: string | null;
    document_language?: string;
    apply_fiscal_stamp?: boolean;
    budget_cap: string | null;
    requester_user_id: string;
    created_at: string;
    updated_at: string;
  };
  latest_version: {
    version_number: number;
    payload: {
      title?: string;
      item_summary?: string;
      quantity?: number;
      unit?: string;
      currency_code?: string;
      location?: string | null;
      budget_cap?: string | null;
      delivery_window_days?: number | null;
      mandatory_specs?: string[];
    };
    missing_fields: string[];
    payload_hash: string;
    created_at: string;
  } | null;
  version_count: number;
  run: {
    run_id: string;
    phase: string;
    status: string;
    projection?: {
      draft_card?: {
        model_metadata?: {
          actual_model?: string;
          provider?: string | null;
          cache_hit?: boolean;
          prompt_tokens?: number;
          completion_tokens?: number;
          cost_usd?: string | null;
          latency_ms?: number;
        };
      };
      react_trace?: ReactStep[];
      external_leads?: ExternalLead[];
    };
    last_error_code?: string | null;
    last_error_message?: string | null;
  } | null;
  rfqs: Array<{
    id: string;
    rfq_code: string;
    request_version: number;
    supplier_ids: string[];
    supplier_names: string[];
    response_deadline_days: number;
    status: string;
    has_pdf: boolean;
    distribution_note: string | null;
    distributed_at: string | null;
    created_at: string;
  }>;
  quotations: Array<{
    id: string;
    quote_code: string;
    revision_number: number;
    supplier_id: string;
    supplier_name: string;
    currency_code: string;
    quantity: number;
    unit_price: string;
    discount_amount: string;
    freight_amount: string | null;
    quoted_tax_amount: string | null;
    fiscal_stamp_amount?: string;
    delivery_days: number | null;
    warranty_months: number | null;
    payment_terms: string;
    meets_mandatory_specs: boolean;
    valid_until: string;
    source_filename: string | null;
    has_source_file: boolean;
    is_demo_example?: boolean;
    offered_specs_text?: string | null;
    spec_verification?: SpecVerification | null;
    corrections: Array<{
      field: string;
      old_value: string | null;
      new_value: string | null;
      editor_name: string;
      reason: string;
      corrected_at: string;
    }>;
    confirmed: boolean;
  }>;
  latest_comparison: {
    id: string;
    version_number: number;
    request_version: number;
    recommended_quotation_id: string | null;
    explanation: string;
    result: {
      request_summary: {
        quantity: number;
        currency_code: string;
        budget_cap: string | null;
        delivery_window_days: number | null;
        apply_fiscal_stamp?: boolean;
      };
      offers: ComparisonOffer[];
      eligible_count: number;
      ineligible_count: number;
      needs_clarification_count: number;
      recommended_supplier_name: string | null;
      recommended_budget_headroom: string | null;
      explanation: string;
    };
    created_at: string;
  } | null;
  pending_approval: {
    id: string;
    decision_type: string;
    entity_version: number;
    payload_hash: string;
    amount: string;
    currency_code: string;
    requester_user_id: string;
    can_current_actor_approve?: boolean;
    status: string;
    packet: Record<string, unknown>;
    expires_at: string;
  } | null;
  decisions: Array<{
    id: string;
    decision_type: string;
    outcome: string;
    actor_user_id: string;
    authority_basis: string;
    payload_hash: string;
    note: string | null;
    decided_at: string;
  }>;
  purchase_order: {
    id: string;
    po_number: string | null;
    status: string;
    supplier_id: string;
    supplier_name: string;
    currency_code: string;
    total_amount: string;
    commercial_payload: Record<string, unknown>;
    payload_hash: string;
    has_pdf: boolean;
    pdf_sha256: string | null;
    external_issue_note: string | null;
    externally_issued_at: string | null;
  } | null;
}

export interface UsageSummary {
  tenant_id: string;
  daily_budget_usd: string;
  combined_24h_spend_usd: string;
  remaining_24h_budget_usd: string;
  total_combined_spend_usd: string;
  llm: {
    total_calls: number;
    cache_hits: number;
    observed_cost_usd: string;
    cost_24h_usd: string;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    reasoning_tokens: number;
  };
  tavily: {
    total_calls: number;
    total_credits: number;
    estimated_cost_usd: string;
    cost_24h_usd: string;
    cost_per_credit_usd: string;
  };
  recent: Array<{
    id: string;
    run_id: string | null;
    profile: string;
    actual_model: string | null;
    provider: string | null;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    cost_usd: string | null;
    latency_ms: number;
    outcome: string;
    created_at: string;
  }>;
  recent_tavily: Array<{
    id: string;
    run_id: string | null;
    query_preview: string;
    search_depth: string;
    results_count: number;
    credits_used: number;
    estimated_cost_usd: string;
    latency_ms: number;
    outcome: string;
    created_at: string;
  }>;
}

export interface TenantSettings {
  tenant_id: string;
  tenant_name: string;
  base_currency: string;
  external_search_enabled: boolean;
  server_external_search_enabled: boolean;
  effective_external_search_enabled: boolean;
  daily_ai_budget_usd: string;
  llm_cache_ttl_seconds: number;
  tavily_cost_per_credit_usd: string;
  default_location?: string | null;
  default_language?: string;
  can_edit_settings: boolean;
  can_edit_company_profile?: boolean;
}

export interface OverviewSummary {
  kpis: {
    open_requests: number;
    awaiting_approval: number;
    quotes_to_review: number;
    approved_pos: number;
  };
  pending_approvals: Array<{
    approval_id: string;
    request_id: string;
    reference_code: string;
    title: string;
    decision_type: string;
    amount: string;
    currency_code: string;
    supplier_name?: string | null;
    can_current_actor_approve: boolean;
    created_at: string;
  }>;
}

export interface AgentsActivityData {
  worker: {
    status: string;
    mode: string;
    heartbeat_age_seconds: number | null;
    active_runs: number;
    outbox: {
      pending: number;
      processing: number;
      processed: number;
      failed: number;
    };
  };
  agents: Array<{
    id: string;
    name_en: string;
    name_fr: string;
    role_en: string;
    role_fr: string;
    backbone: string;
    profile: string;
    status: string;
    calls: number;
    cache_hits: number;
    avg_latency_ms: number;
    cost_usd: string;
    last_active_at: string | null;
  }>;
  logs: Array<{
    id: string;
    category: string;
    source: string;
    event_type: string;
    status: string;
    reference_code: string | null;
    request_id: string | null;
    summary: string;
    payload: Record<string, unknown>;
    created_at: string;
  }>;
}

export interface EvalSuiteReport {
  evaluated_at: string;
  live_llm_ran: boolean;
  live_model_route: string | null;
  live_observed_cost_usd: string;
  total_cases: number;
  passed_cases: number;
  pass_rate_pct: number;
  dev_summary: { passed: number; total: number };
  held_out_summary: { passed: number; total: number };
  cases: Array<{
    id: string;
    split: "dev" | "held_out";
    category: string;
    passed: boolean;
    detail: string;
  }>;
}

export interface CopilotAction {
  action_type: "jump_stage" | "prefill_draft";
  request_id?: string | null;
  target_stage?: number;
  label: string;
  draft_patch?: {
    title?: string;
    item_summary?: string;
    quantity?: number;
    budget_cap?: string;
    currency_code?: string;
    location?: string;
    delivery_window_days?: number;
    mandatory_specs?: string[];
  } | null;
}
