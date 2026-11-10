
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "admin_users": {
                  Row: {
                    "added_by": string | null,"created_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "added_by"?: string | null,"created_at"?: string,"user_id": string
                  }
                  Update: {
                    "added_by"?: string | null,"created_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"categories": {
                  Row: {
                    "created_at": string,"description": string,"icon_identifier": string,"id": string,"is_active": boolean,"name": string,"slug": string,"sort_order": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"description"?: string,"icon_identifier"?: string,"id"?: string,"is_active"?: boolean,"name": string,"slug": string,"sort_order"?: number,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"description"?: string,"icon_identifier"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"slug"?: string,"sort_order"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"discovery_queries": {
                  Row: {
                    "candidates_found": number,"created_at": string,"cursor": Json | null,"date_range": NonNullable<Json>,"finished_at": string | null,"id": string,"incomplete_results": boolean,"intended_coverage": string,"job_id": string | null,"last_error": string | null,"lease_expires_at": string | null,"lease_token": string | null,"lock_owner": string | null,"locked_at": string | null,"max_attempts": number,"next_attempt_at": string | null,"pages_fetched": number,"parent_query_id": string | null,"partition_key": string,"plan_name": string,"plan_version": string,"provider": string,"query_fingerprint": string,"query_parameters": NonNullable<Json>,"query_text": string,"retry_count": number,"started_at": string | null,"status": string,"total_count": number | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "candidates_found"?: number,"created_at"?: string,"cursor"?: Json | null,"date_range"?: NonNullable<Json>,"finished_at"?: string | null,"id"?: string,"incomplete_results"?: boolean,"intended_coverage"?: string,"job_id"?: string | null,"last_error"?: string | null,"lease_expires_at"?: string | null,"lease_token"?: string | null,"lock_owner"?: string | null,"locked_at"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"pages_fetched"?: number,"parent_query_id"?: string | null,"partition_key": string,"plan_name"?: string,"plan_version"?: string,"provider": string,"query_fingerprint"?: string,"query_parameters"?: NonNullable<Json>,"query_text": string,"retry_count"?: number,"started_at"?: string | null,"status"?: string,"total_count"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "candidates_found"?: number,"created_at"?: string,"cursor"?: Json | null,"date_range"?: NonNullable<Json>,"finished_at"?: string | null,"id"?: string,"incomplete_results"?: boolean,"intended_coverage"?: string,"job_id"?: string | null,"last_error"?: string | null,"lease_expires_at"?: string | null,"lease_token"?: string | null,"lock_owner"?: string | null,"locked_at"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"pages_fetched"?: number,"parent_query_id"?: string | null,"partition_key"?: string,"plan_name"?: string,"plan_version"?: string,"provider"?: string,"query_fingerprint"?: string,"query_parameters"?: NonNullable<Json>,"query_text"?: string,"retry_count"?: number,"started_at"?: string | null,"status"?: string,"total_count"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "discovery_queries_job_id_fkey"
      columns: ["job_id"]
isOneToOne: false
      referencedRelation: "ingestion_jobs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "discovery_queries_parent_query_id_fkey"
      columns: ["parent_query_id"]
isOneToOne: false
      referencedRelation: "discovery_queries"
      referencedColumns: ["id"]
    }
                  ]
                },"editorial_decisions": {
                  Row: {
                    "action": string,"actor_user_id": string,"created_at": string,"evidence": NonNullable<Json>,"id": string,"previous_state": string,"project_id": string,"reason": string,"resulting_revision": number,"resulting_state": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_user_id": string,"created_at"?: string,"evidence"?: NonNullable<Json>,"id"?: string,"previous_state": string,"project_id": string,"reason": string,"resulting_revision": number,"resulting_state": string
                  }
                  Update: {
                    "action"?: string,"actor_user_id"?: string,"created_at"?: string,"evidence"?: NonNullable<Json>,"id"?: string,"previous_state"?: string,"project_id"?: string,"reason"?: string,"resulting_revision"?: number,"resulting_state"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "editorial_decisions_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    }
                  ]
                },"editorial_overrides": {
                  Row: {
                    "approved_at": string,"approved_by": string,"created_at": string,"created_by": string | null,"field_key": string,"id": string,"override_value": NonNullable<Json>,"project_id": string,"source_record_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "approved_at": string,"approved_by": string,"created_at"?: string,"created_by"?: string | null,"field_key": string,"id"?: string,"override_value": NonNullable<Json>,"project_id": string,"source_record_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "approved_at"?: string,"approved_by"?: string,"created_at"?: string,"created_by"?: string | null,"field_key"?: string,"id"?: string,"override_value"?: NonNullable<Json>,"project_id"?: string,"source_record_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "editorial_overrides_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "editorial_overrides_source_record_id_fkey"
      columns: ["source_record_id"]
isOneToOne: false
      referencedRelation: "source_records"
      referencedColumns: ["id"]
    }
                  ]
                },"ingestion_items": {
                  Row: {
                    "attempts": number,"candidate_id": string | null,"created_at": string,"finished_at": string | null,"id": string,"item_key": string,"item_type": string,"job_id": string,"last_error": string | null,"lock_owner": string | null,"locked_at": string | null,"max_attempts": number,"next_attempt_at": string | null,"repository_id": string | null,"result": Json | null,"started_at": string | null,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"candidate_id"?: string | null,"created_at"?: string,"finished_at"?: string | null,"id"?: string,"item_key": string,"item_type": string,"job_id": string,"last_error"?: string | null,"lock_owner"?: string | null,"locked_at"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"repository_id"?: string | null,"result"?: Json | null,"started_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "attempts"?: number,"candidate_id"?: string | null,"created_at"?: string,"finished_at"?: string | null,"id"?: string,"item_key"?: string,"item_type"?: string,"job_id"?: string,"last_error"?: string | null,"lock_owner"?: string | null,"locked_at"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"repository_id"?: string | null,"result"?: Json | null,"started_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ingestion_items_candidate_id_fkey"
      columns: ["candidate_id"]
isOneToOne: false
      referencedRelation: "repository_candidates"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ingestion_items_job_id_fkey"
      columns: ["job_id"]
isOneToOne: false
      referencedRelation: "ingestion_jobs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ingestion_items_repository_id_fkey"
      columns: ["repository_id"]
isOneToOne: false
      referencedRelation: "repositories"
      referencedColumns: ["id"]
    }
                  ]
                },"ingestion_jobs": {
                  Row: {
                    "catalog_import_lease_expires_at": string | null,"catalog_import_lease_token": string | null,"created_at": string,"error_summary": string | null,"finished_at": string | null,"id": string,"items_created": number,"items_discovered": number,"items_failed": number,"items_processed": number,"items_skipped": number,"items_updated": number,"job_type": string,"metadata": NonNullable<Json>,"provider": string | null,"started_at": string | null,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "catalog_import_lease_expires_at"?: string | null,"catalog_import_lease_token"?: string | null,"created_at"?: string,"error_summary"?: string | null,"finished_at"?: string | null,"id"?: string,"items_created"?: number,"items_discovered"?: number,"items_failed"?: number,"items_processed"?: number,"items_skipped"?: number,"items_updated"?: number,"job_type": string,"metadata"?: NonNullable<Json>,"provider"?: string | null,"started_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "catalog_import_lease_expires_at"?: string | null,"catalog_import_lease_token"?: string | null,"created_at"?: string,"error_summary"?: string | null,"finished_at"?: string | null,"id"?: string,"items_created"?: number,"items_discovered"?: number,"items_failed"?: number,"items_processed"?: number,"items_skipped"?: number,"items_updated"?: number,"job_type"?: string,"metadata"?: NonNullable<Json>,"provider"?: string | null,"started_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"project_alternatives": {
                  Row: {
                    "alternative_project_id": string | null,"created_at": string,"id": string,"project_id": string,"relationship_type": string,"review_notes": string | null,"review_status": string,"reviewed_at": string | null,"reviewed_by": string | null,"software_name": string | null,"software_url": string | null,"source_record_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "alternative_project_id"?: string | null,"created_at"?: string,"id"?: string,"project_id": string,"relationship_type"?: string,"review_notes"?: string | null,"review_status"?: string,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"software_name"?: string | null,"software_url"?: string | null,"source_record_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "alternative_project_id"?: string | null,"created_at"?: string,"id"?: string,"project_id"?: string,"relationship_type"?: string,"review_notes"?: string | null,"review_status"?: string,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"software_name"?: string | null,"software_url"?: string | null,"source_record_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_alternatives_alternative_project_id_fkey"
      columns: ["alternative_project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "project_alternatives_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "project_alternatives_source_record_id_fkey"
      columns: ["source_record_id"]
isOneToOne: false
      referencedRelation: "source_records"
      referencedColumns: ["id"]
    }
                  ]
                },"project_categories": {
                  Row: {
                    "category_id": string,"created_at": string,"project_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "category_id": string,"created_at"?: string,"project_id": string
                  }
                  Update: {
                    "category_id"?: string,"created_at"?: string,"project_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_categories_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "project_categories_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    }
                  ]
                },"project_logos": {
                  Row: {
                    "approval_lease_expires_at": string | null,"approval_provenance": Json | null,"approval_token": string | null,"approval_worker_id": string | null,"attribution_text": string | null,"candidate_key": string | null,"content_digest": string | null,"created_at": string,"id": string,"is_primary": boolean,"media_type": string,"origin": string,"project_id": string,"repository_id": string | null,"source_observed_at": string | null,"source_provenance": NonNullable<Json>,"source_record_id": string | null,"source_url": string,"storage_path": string | null,"updated_at": string,"verification_status": string,"verified_at": string | null,"verified_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "approval_lease_expires_at"?: string | null,"approval_provenance"?: Json | null,"approval_token"?: string | null,"approval_worker_id"?: string | null,"attribution_text"?: string | null,"candidate_key"?: string | null,"content_digest"?: string | null,"created_at"?: string,"id"?: string,"is_primary"?: boolean,"media_type": string,"origin": string,"project_id": string,"repository_id"?: string | null,"source_observed_at"?: string | null,"source_provenance"?: NonNullable<Json>,"source_record_id"?: string | null,"source_url": string,"storage_path"?: string | null,"updated_at"?: string,"verification_status"?: string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Update: {
                    "approval_lease_expires_at"?: string | null,"approval_provenance"?: Json | null,"approval_token"?: string | null,"approval_worker_id"?: string | null,"attribution_text"?: string | null,"candidate_key"?: string | null,"content_digest"?: string | null,"created_at"?: string,"id"?: string,"is_primary"?: boolean,"media_type"?: string,"origin"?: string,"project_id"?: string,"repository_id"?: string | null,"source_observed_at"?: string | null,"source_provenance"?: NonNullable<Json>,"source_record_id"?: string | null,"source_url"?: string,"storage_path"?: string | null,"updated_at"?: string,"verification_status"?: string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_logos_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "project_logos_repository_id_fkey"
      columns: ["repository_id"]
isOneToOne: false
      referencedRelation: "repositories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "project_logos_source_record_id_fkey"
      columns: ["source_record_id"]
isOneToOne: false
      referencedRelation: "source_records"
      referencedColumns: ["id"]
    }
                  ]
                },"project_safety_events": {
                  Row: {
                    "candidate_id": string,"created_at": string,"event_type": string,"id": string,"origin": string,"previous_publication_status": string,"project_id": string,"provider": string,"provider_repository_id": string,"repository_id": string,"resulting_publication_status": string,"resulting_revision": number,"source_observed_at": string,"source_url": string,"visibility_signal": string
                  }
                  ComputedFields: never
                  Insert: {
                    "candidate_id": string,"created_at"?: string,"event_type": string,"id"?: string,"origin"?: string,"previous_publication_status": string,"project_id": string,"provider"?: string,"provider_repository_id": string,"repository_id": string,"resulting_publication_status": string,"resulting_revision": number,"source_observed_at": string,"source_url": string,"visibility_signal": string
                  }
                  Update: {
                    "candidate_id"?: string,"created_at"?: string,"event_type"?: string,"id"?: string,"origin"?: string,"previous_publication_status"?: string,"project_id"?: string,"provider"?: string,"provider_repository_id"?: string,"repository_id"?: string,"resulting_publication_status"?: string,"resulting_revision"?: number,"source_observed_at"?: string,"source_url"?: string,"visibility_signal"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_safety_events_candidate_id_fkey"
      columns: ["candidate_id"]
isOneToOne: false
      referencedRelation: "repository_candidates"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "project_safety_events_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "project_safety_events_repository_id_fkey"
      columns: ["repository_id"]
isOneToOne: false
      referencedRelation: "repositories"
      referencedColumns: ["id"]
    }
                  ]
                },"project_tags": {
                  Row: {
                    "created_at": string,"project_id": string,"tag_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"project_id": string,"tag_id": string
                  }
                  Update: {
                    "created_at"?: string,"project_id"?: string,"tag_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_tags_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "project_tags_tag_id_fkey"
      columns: ["tag_id"]
isOneToOne: false
      referencedRelation: "tags"
      referencedColumns: ["id"]
    }
                  ]
                },"projects": {
                  Row: {
                    "created_at": string,"description": string,"editorial_rank": number,"editorial_revision": number,"featured": boolean,"id": string,"last_verified_at": string | null,"license_identifier": string | null,"license_status": string,"license_verified_at": string | null,"name": string,"official_website_url": string | null,"primary_repository_id": string | null,"publication_status": string,"published_at": string | null,"quality_status": string,"search_document": unknown,"slug": string,"summary": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"description"?: string,"editorial_rank"?: number,"editorial_revision"?: number,"featured"?: boolean,"id"?: string,"last_verified_at"?: string | null,"license_identifier"?: string | null,"license_status"?: string,"license_verified_at"?: string | null,"name"?: string,"official_website_url"?: string | null,"primary_repository_id"?: string | null,"publication_status"?: string,"published_at"?: string | null,"quality_status"?: string,"search_document"?: never,"slug": string,"summary"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"description"?: string,"editorial_rank"?: number,"editorial_revision"?: number,"featured"?: boolean,"id"?: string,"last_verified_at"?: string | null,"license_identifier"?: string | null,"license_status"?: string,"license_verified_at"?: string | null,"name"?: string,"official_website_url"?: string | null,"primary_repository_id"?: string | null,"publication_status"?: string,"published_at"?: string | null,"quality_status"?: string,"search_document"?: never,"slug"?: string,"summary"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "projects_primary_repository_same_project_fk"
      columns: ["id","primary_repository_id"]
isOneToOne: false
      referencedRelation: "repositories"
      referencedColumns: ["project_id","id"]
    }
                  ]
                },"releases": {
                  Row: {
                    "created_at": string,"id": string,"is_draft": boolean,"is_prerelease": boolean,"provider_release_id": string,"published_at": string | null,"release_name": string | null,"release_url": string,"repository_id": string,"source_observed_at": string | null,"source_record_id": string | null,"updated_at": string,"version": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_draft"?: boolean,"is_prerelease"?: boolean,"provider_release_id": string,"published_at"?: string | null,"release_name"?: string | null,"release_url": string,"repository_id": string,"source_observed_at"?: string | null,"source_record_id"?: string | null,"updated_at"?: string,"version": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_draft"?: boolean,"is_prerelease"?: boolean,"provider_release_id"?: string,"published_at"?: string | null,"release_name"?: string | null,"release_url"?: string,"repository_id"?: string,"source_observed_at"?: string | null,"source_record_id"?: string | null,"updated_at"?: string,"version"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "releases_repository_id_fkey"
      columns: ["repository_id"]
isOneToOne: false
      referencedRelation: "repositories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "releases_source_record_id_fkey"
      columns: ["source_record_id"]
isOneToOne: false
      referencedRelation: "source_records"
      referencedColumns: ["id"]
    }
                  ]
                },"repositories": {
                  Row: {
                    "availability_status": string,"canonical_url": string,"created_at": string,"default_branch": string | null,"description": string | null,"forks": number,"full_name": string,"homepage_url": string | null,"id": string,"is_archived": boolean,"is_disabled": boolean | null,"is_fork": boolean,"is_private": boolean | null,"last_successful_sync_at": string | null,"open_issues": number | null,"owner_login": string | null,"primary_language": string | null,"project_id": string | null,"provider": string,"provider_created_at": string | null,"provider_node_id": string | null,"provider_pushed_at": string | null,"provider_repository_id": string,"provider_updated_at": string | null,"repository_name": string | null,"source_field_states": NonNullable<Json>,"source_license_metadata": Json | null,"source_observed_at": string | null,"stars": number,"updated_at": string,"visibility": string | null,"watchers": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "availability_status"?: string,"canonical_url": string,"created_at"?: string,"default_branch"?: string | null,"description"?: string | null,"forks"?: number,"full_name": string,"homepage_url"?: string | null,"id"?: string,"is_archived"?: boolean,"is_disabled"?: boolean | null,"is_fork"?: boolean,"is_private"?: boolean | null,"last_successful_sync_at"?: string | null,"open_issues"?: number | null,"owner_login"?: string | null,"primary_language"?: string | null,"project_id"?: string | null,"provider": string,"provider_created_at"?: string | null,"provider_node_id"?: string | null,"provider_pushed_at"?: string | null,"provider_repository_id": string,"provider_updated_at"?: string | null,"repository_name"?: string | null,"source_field_states"?: NonNullable<Json>,"source_license_metadata"?: Json | null,"source_observed_at"?: string | null,"stars"?: number,"updated_at"?: string,"visibility"?: string | null,"watchers"?: number | null
                  }
                  Update: {
                    "availability_status"?: string,"canonical_url"?: string,"created_at"?: string,"default_branch"?: string | null,"description"?: string | null,"forks"?: number,"full_name"?: string,"homepage_url"?: string | null,"id"?: string,"is_archived"?: boolean,"is_disabled"?: boolean | null,"is_fork"?: boolean,"is_private"?: boolean | null,"last_successful_sync_at"?: string | null,"open_issues"?: number | null,"owner_login"?: string | null,"primary_language"?: string | null,"project_id"?: string | null,"provider"?: string,"provider_created_at"?: string | null,"provider_node_id"?: string | null,"provider_pushed_at"?: string | null,"provider_repository_id"?: string,"provider_updated_at"?: string | null,"repository_name"?: string | null,"source_field_states"?: NonNullable<Json>,"source_license_metadata"?: Json | null,"source_observed_at"?: string | null,"stars"?: number,"updated_at"?: string,"visibility"?: string | null,"watchers"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "repositories_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_assessment_sources": {
                  Row: {
                    "assessment_id": string,"source_record_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assessment_id": string,"source_record_id": string
                  }
                  Update: {
                    "assessment_id"?: string,"source_record_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_assessment_sources_assessment_id_fkey"
      columns: ["assessment_id"]
isOneToOne: false
      referencedRelation: "repository_assessments"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_assessment_sources_source_record_id_fkey"
      columns: ["source_record_id"]
isOneToOne: false
      referencedRelation: "source_records"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_assessments": {
                  Row: {
                    "assessed_at": string | null,"attempts": number,"created_at": string,"id": string,"job_id": string | null,"last_error": string | null,"lease_expires_at": string | null,"lease_token": string | null,"lock_owner": string | null,"locked_at": string | null,"max_attempts": number,"next_attempt_at": string | null,"policy_version": string,"repository_id": string,"result": Json | null,"source_observed_at": string,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assessed_at"?: string | null,"attempts"?: number,"created_at"?: string,"id"?: string,"job_id"?: string | null,"last_error"?: string | null,"lease_expires_at"?: string | null,"lease_token"?: string | null,"lock_owner"?: string | null,"locked_at"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"policy_version": string,"repository_id": string,"result"?: Json | null,"source_observed_at": string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "assessed_at"?: string | null,"attempts"?: number,"created_at"?: string,"id"?: string,"job_id"?: string | null,"last_error"?: string | null,"lease_expires_at"?: string | null,"lease_token"?: string | null,"lock_owner"?: string | null,"locked_at"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"policy_version"?: string,"repository_id"?: string,"result"?: Json | null,"source_observed_at"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_assessments_job_id_fkey"
      columns: ["job_id"]
isOneToOne: false
      referencedRelation: "ingestion_jobs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_assessments_repository_id_fkey"
      columns: ["repository_id"]
isOneToOne: false
      referencedRelation: "repositories"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_candidate_sources": {
                  Row: {
                    "candidate_id": string,"created_at": string,"discovery_query_id": string,"fetched_at": string,"source_record_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "candidate_id": string,"created_at"?: string,"discovery_query_id": string,"fetched_at": string,"source_record_id": string
                  }
                  Update: {
                    "candidate_id"?: string,"created_at"?: string,"discovery_query_id"?: string,"fetched_at"?: string,"source_record_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_candidate_sources_candidate_id_fkey"
      columns: ["candidate_id"]
isOneToOne: false
      referencedRelation: "repository_candidates"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_candidate_sources_discovery_query_id_fkey"
      columns: ["discovery_query_id"]
isOneToOne: false
      referencedRelation: "discovery_queries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_candidate_sources_source_record_id_fkey"
      columns: ["source_record_id"]
isOneToOne: false
      referencedRelation: "source_records"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_candidates": {
                  Row: {
                    "attempts": number,"canonical_url": string,"completed_at": string | null,"created_at": string,"description": string | null,"discovery_query_id": string | null,"enrichment_attempts": number,"enrichment_completed_at": string | null,"enrichment_error": string | null,"enrichment_job_id": string | null,"enrichment_lease_expires_at": string | null,"enrichment_lease_token": string | null,"enrichment_lock_owner": string | null,"enrichment_locked_at": string | null,"enrichment_max_attempts": number,"enrichment_next_attempt_at": string | null,"enrichment_status": string,"first_seen_at": string,"forks": number,"full_name": string,"id": string,"last_error": string | null,"last_seen_at": string,"lock_owner": string | null,"locked_at": string | null,"max_attempts": number,"next_attempt_at": string | null,"owner_login": string | null,"primary_language": string | null,"provider": string,"provider_created_at": string | null,"provider_pushed_at": string | null,"provider_repository_id": string,"provider_updated_at": string | null,"queue_status": string,"repository_id": string | null,"review_status": string,"source_license_summary": Json | null,"source_record_id": string,"stars": number,"topics": (string)[],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"canonical_url": string,"completed_at"?: string | null,"created_at"?: string,"description"?: string | null,"discovery_query_id"?: string | null,"enrichment_attempts"?: number,"enrichment_completed_at"?: string | null,"enrichment_error"?: string | null,"enrichment_job_id"?: string | null,"enrichment_lease_expires_at"?: string | null,"enrichment_lease_token"?: string | null,"enrichment_lock_owner"?: string | null,"enrichment_locked_at"?: string | null,"enrichment_max_attempts"?: number,"enrichment_next_attempt_at"?: string | null,"enrichment_status"?: string,"first_seen_at"?: string,"forks"?: number,"full_name": string,"id"?: string,"last_error"?: string | null,"last_seen_at"?: string,"lock_owner"?: string | null,"locked_at"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"owner_login"?: string | null,"primary_language"?: string | null,"provider": string,"provider_created_at"?: string | null,"provider_pushed_at"?: string | null,"provider_repository_id": string,"provider_updated_at"?: string | null,"queue_status"?: string,"repository_id"?: string | null,"review_status"?: string,"source_license_summary"?: Json | null,"source_record_id": string,"stars"?: number,"topics"?: (string)[],"updated_at"?: string
                  }
                  Update: {
                    "attempts"?: number,"canonical_url"?: string,"completed_at"?: string | null,"created_at"?: string,"description"?: string | null,"discovery_query_id"?: string | null,"enrichment_attempts"?: number,"enrichment_completed_at"?: string | null,"enrichment_error"?: string | null,"enrichment_job_id"?: string | null,"enrichment_lease_expires_at"?: string | null,"enrichment_lease_token"?: string | null,"enrichment_lock_owner"?: string | null,"enrichment_locked_at"?: string | null,"enrichment_max_attempts"?: number,"enrichment_next_attempt_at"?: string | null,"enrichment_status"?: string,"first_seen_at"?: string,"forks"?: number,"full_name"?: string,"id"?: string,"last_error"?: string | null,"last_seen_at"?: string,"lock_owner"?: string | null,"locked_at"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"owner_login"?: string | null,"primary_language"?: string | null,"provider"?: string,"provider_created_at"?: string | null,"provider_pushed_at"?: string | null,"provider_repository_id"?: string,"provider_updated_at"?: string | null,"queue_status"?: string,"repository_id"?: string | null,"review_status"?: string,"source_license_summary"?: Json | null,"source_record_id"?: string,"stars"?: number,"topics"?: (string)[],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_candidates_discovery_query_id_fkey"
      columns: ["discovery_query_id"]
isOneToOne: false
      referencedRelation: "discovery_queries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_candidates_enrichment_job_id_fkey"
      columns: ["enrichment_job_id"]
isOneToOne: false
      referencedRelation: "ingestion_jobs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_candidates_repository_id_fkey"
      columns: ["repository_id"]
isOneToOne: true
      referencedRelation: "repositories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_candidates_source_record_id_fkey"
      columns: ["source_record_id"]
isOneToOne: false
      referencedRelation: "source_records"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_languages": {
                  Row: {
                    "bytes": number,"language_key": string,"language_name": string,"measured_at": string,"repository_id": string,"source_record_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "bytes": number,"language_key"?: never,"language_name": string,"measured_at": string,"repository_id": string,"source_record_id"?: string | null
                  }
                  Update: {
                    "bytes"?: number,"language_key"?: never,"language_name"?: string,"measured_at"?: string,"repository_id"?: string,"source_record_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_languages_repository_id_fkey"
      columns: ["repository_id"]
isOneToOne: false
      referencedRelation: "repositories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_languages_source_record_id_fkey"
      columns: ["source_record_id"]
isOneToOne: false
      referencedRelation: "source_records"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_snapshots": {
                  Row: {
                    "captured_at": string,"created_at": string,"forks": number,"id": string,"repository_id": string,"snapshot_date": string,"source_record_id": string | null,"stars": number
                  }
                  ComputedFields: never
                  Insert: {
                    "captured_at": string,"created_at"?: string,"forks": number,"id"?: string,"repository_id": string,"snapshot_date": string,"source_record_id"?: string | null,"stars": number
                  }
                  Update: {
                    "captured_at"?: string,"created_at"?: string,"forks"?: number,"id"?: string,"repository_id"?: string,"snapshot_date"?: string,"source_record_id"?: string | null,"stars"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_snapshots_repository_id_fkey"
      columns: ["repository_id"]
isOneToOne: false
      referencedRelation: "repositories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_snapshots_source_record_id_fkey"
      columns: ["source_record_id"]
isOneToOne: false
      referencedRelation: "source_records"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_topics": {
                  Row: {
                    "observed_at": string,"repository_id": string,"source_record_id": string | null,"source_topic": string,"topic_key": string
                  }
                  ComputedFields: never
                  Insert: {
                    "observed_at"?: string,"repository_id": string,"source_record_id"?: string | null,"source_topic": string,"topic_key"?: never
                  }
                  Update: {
                    "observed_at"?: string,"repository_id"?: string,"source_record_id"?: string | null,"source_topic"?: string,"topic_key"?: never
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_topics_repository_id_fkey"
      columns: ["repository_id"]
isOneToOne: false
      referencedRelation: "repositories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "repository_topics_source_record_id_fkey"
      columns: ["source_record_id"]
isOneToOne: false
      referencedRelation: "source_records"
      referencedColumns: ["id"]
    }
                  ]
                },"review_queue": {
                  Row: {
                    "assessment_id": string | null,"assigned_to": string | null,"created_at": string,"id": string,"project_alternative_id": string | null,"project_id": string | null,"project_logo_id": string | null,"reason": string,"repository_id": string | null,"resolved_at": string | null,"status": string,"submission_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assessment_id"?: string | null,"assigned_to"?: string | null,"created_at"?: string,"id"?: string,"project_alternative_id"?: string | null,"project_id"?: string | null,"project_logo_id"?: string | null,"reason": string,"repository_id"?: string | null,"resolved_at"?: string | null,"status"?: string,"submission_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "assessment_id"?: string | null,"assigned_to"?: string | null,"created_at"?: string,"id"?: string,"project_alternative_id"?: string | null,"project_id"?: string | null,"project_logo_id"?: string | null,"reason"?: string,"repository_id"?: string | null,"resolved_at"?: string | null,"status"?: string,"submission_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "review_queue_assessment_id_fkey"
      columns: ["assessment_id"]
isOneToOne: false
      referencedRelation: "repository_assessments"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "review_queue_project_alternative_id_fkey"
      columns: ["project_alternative_id"]
isOneToOne: false
      referencedRelation: "project_alternatives"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "review_queue_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "review_queue_project_logo_id_fkey"
      columns: ["project_logo_id"]
isOneToOne: false
      referencedRelation: "project_logos"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "review_queue_repository_id_fkey"
      columns: ["repository_id"]
isOneToOne: false
      referencedRelation: "repositories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "review_queue_submission_id_fkey"
      columns: ["submission_id"]
isOneToOne: false
      referencedRelation: "submissions"
      referencedColumns: ["id"]
    }
                  ]
                },"source_records": {
                  Row: {
                    "candidate_id": string | null,"created_at": string,"etag": string | null,"fetched_at": string,"http_status": number | null,"id": string,"provider": string,"raw_payload": Json | null,"record_kind": string,"repository_id": string | null,"reuse_context": string | null,"source_key": string,"source_metadata": NonNullable<Json>,"source_url": string
                  }
                  ComputedFields: never
                  Insert: {
                    "candidate_id"?: string | null,"created_at"?: string,"etag"?: string | null,"fetched_at": string,"http_status"?: number | null,"id"?: string,"provider": string,"raw_payload"?: Json | null,"record_kind": string,"repository_id"?: string | null,"reuse_context"?: string | null,"source_key": string,"source_metadata"?: NonNullable<Json>,"source_url": string
                  }
                  Update: {
                    "candidate_id"?: string | null,"created_at"?: string,"etag"?: string | null,"fetched_at"?: string,"http_status"?: number | null,"id"?: string,"provider"?: string,"raw_payload"?: Json | null,"record_kind"?: string,"repository_id"?: string | null,"reuse_context"?: string | null,"source_key"?: string,"source_metadata"?: NonNullable<Json>,"source_url"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "source_records_candidate_id_fkey"
      columns: ["candidate_id"]
isOneToOne: false
      referencedRelation: "repository_candidates"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "source_records_repository_id_fkey"
      columns: ["repository_id"]
isOneToOne: false
      referencedRelation: "repositories"
      referencedColumns: ["id"]
    }
                  ]
                },"submissions": {
                  Row: {
                    "category_id": string | null,"created_at": string,"id": string,"project_id": string | null,"proposed_values": NonNullable<Json>,"repository_url": string | null,"request_type": string,"requester_contact": string | null,"review_status": string,"reviewed_at": string | null,"reviewed_by": string | null,"reviewer_notes": string | null,"suggested_name": string | null,"updated_at": string,"validation_error": string | null,"validation_status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "category_id"?: string | null,"created_at"?: string,"id"?: string,"project_id"?: string | null,"proposed_values"?: NonNullable<Json>,"repository_url"?: string | null,"request_type": string,"requester_contact"?: string | null,"review_status"?: string,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"reviewer_notes"?: string | null,"suggested_name"?: string | null,"updated_at"?: string,"validation_error"?: string | null,"validation_status"?: string
                  }
                  Update: {
                    "category_id"?: string | null,"created_at"?: string,"id"?: string,"project_id"?: string | null,"proposed_values"?: NonNullable<Json>,"repository_url"?: string | null,"request_type"?: string,"requester_contact"?: string | null,"review_status"?: string,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"reviewer_notes"?: string | null,"suggested_name"?: string | null,"updated_at"?: string,"validation_error"?: string | null,"validation_status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "submissions_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "submissions_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    }
                  ]
                },"tags": {
                  Row: {
                    "created_at": string,"id": string,"name": string,"slug": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"name": string,"slug": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"name"?: string,"slug"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "admin_publish_project":
{ Args: { "p_actor": string,"p_expected_revision": number,"p_project_id": string,"p_reason": string }; Returns: Json
                           },
"admin_resolve_project_review_item":
{ Args: { "p_actor": string,"p_expected_revision": number,"p_project_id": string,"p_queue_id": string,"p_reason": string }; Returns: Json
                           },
"admin_save_project_editorial":
{ Args: { "p_actor": string,"p_category_ids": (string)[],"p_changes": Json,"p_expected_revision": number,"p_project_id": string,"p_reason": string,"p_tags": (string)[] }; Returns: Json
                           },
"admin_set_project_review_state":
{ Args: { "p_action": string,"p_actor": string,"p_expected_revision": number,"p_project_id": string,"p_reason": string }; Returns: Json
                           },
"admin_verify_project_license":
{ Args: { "p_actor": string,"p_confirm_open_source": boolean,"p_evidence_reference": string,"p_expected_revision": number,"p_expected_source_observed_at": string,"p_license_identifier": string,"p_project_id": string,"p_reason": string }; Returns: Json
                           },
"admin_verify_project_quality":
{ Args: { "p_actor": string,"p_confirm_review": boolean,"p_expected_revision": number,"p_expected_source_observed_at": string,"p_project_id": string,"p_reason": string }; Returns: Json
                           },
"approve_project_logo_candidate":
{ Args: { "p_approval_provenance": Json,"p_approval_token": string,"p_content_digest": string,"p_logo_id": string,"p_media_type": string,"p_storage_path": string,"p_worker_id": string }; Returns: Json
                           },
"begin_github_repository_assessment_recovery":
{ Args: { "p_job_id": string,"p_max_assessments": number,"p_worker_id": string }; Returns: Json
                           },
"catalog_import_status":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"claim_discovery_partitions":
{ Args: { "p_job_id": string,"p_lease_seconds"?: number,"p_limit"?: number,"p_worker_id": string }; Returns: {
              "cursor": Json,"id": string,"incomplete_results": boolean,"lease_expires_at": string,"lease_token": string,"partition_key": string,"query_fingerprint": string,"query_parameters": Json,"query_text": string,"total_count": number
            }[]
                           },
"claim_github_enrichment_candidates":
{ Args: { "p_job_id": string,"p_lease_seconds"?: number,"p_limit"?: number,"p_worker_id": string }; Returns: {
              "candidate_id": string,"enrichment_attempts": number,"enrichment_max_attempts": number,"full_name": string,"lease_expires_at": string,"lease_token": string,"owner_login": string,"provider_repository_id": string
            }[]
                           },
"claim_github_repository_assessments":
{ Args: { "p_job_id": string,"p_lease_seconds"?: number,"p_limit"?: number,"p_worker_id": string }; Returns: {
              "assessment_id": string,"lease_expires_at": string,"lease_token": string,"provider_repository_id": string,"repository_id": string
            }[]
                           },
"claim_github_repository_assessments_for_recovery":
{ Args: { "p_job_id": string,"p_lease_seconds"?: number,"p_limit"?: number,"p_worker_id": string }; Returns: {
              "assessment_id": string,"lease_expires_at": string,"lease_token": string,"provider_repository_id": string,"repository_id": string
            }[]
                           },
"claim_project_logo_approval":
{ Args: { "p_logo_id": string,"p_worker_id": string }; Returns: Json
                           },
"claim_project_logo_cleanup":
{ Args: { "p_approval_token": string,"p_logo_id": string,"p_worker_id": string }; Returns: Json
                           },
"commit_catalog_import_batch":
{ Args: { "p_batch_number": number,"p_batch_sha256": string,"p_job_id": string,"p_lease_token": string,"p_records": Json,"p_worker_id": string }; Returns: Json
                           },
"commit_discovery_page":
{ Args: { "p_candidates": Json,"p_children"?: Json,"p_fetched_at": string,"p_http_status": number,"p_incomplete_results": boolean,"p_lease_seconds"?: number,"p_lease_token": string,"p_next_state": string,"p_page": number,"p_per_page": number,"p_query_fingerprint": string,"p_query_id": string,"p_source_metadata": Json,"p_source_url": string,"p_total_count": number,"p_worker_id": string }; Returns: Json
                           },
"commit_github_repository_enrichment":
{ Args: { "p_candidate_id": string,"p_lease_token": string,"p_payload": Json,"p_worker_id": string }; Returns: Json
                           },
"complete_github_repository_assessment":
{ Args: { "p_assessment_id": string,"p_lease_token": string,"p_result": Json,"p_source_record_ids": (string)[],"p_worker_id": string }; Returns: Json
                           },
"fail_discovery_partition":
{ Args: { "p_error_summary": string,"p_lease_token": string,"p_query_id": string,"p_retry_after_ms"?: number,"p_retryable": boolean,"p_worker_id": string }; Returns: Json
                           },
"fail_github_repository_assessment":
{ Args: { "p_assessment_id": string,"p_error_summary": string,"p_lease_token": string,"p_retry_after_ms"?: number,"p_retryable": boolean,"p_worker_id": string }; Returns: Json
                           },
"fail_github_repository_enrichment":
{ Args: { "p_candidate_id": string,"p_error_summary": string,"p_failure_provenance"?: Json,"p_lease_token": string,"p_retry_after_ms"?: number,"p_retryable": boolean,"p_worker_id": string }; Returns: Json
                           },
"finish_catalog_import":
{ Args: { "p_error_summary"?: string,"p_job_id": string,"p_lease_token": string,"p_worker_id": string }; Returns: Json
                           },
"finish_discovery_job":
{ Args: { "p_error_summary"?: string,"p_job_id": string,"p_status": string }; Returns: undefined
                           },
"finish_github_enrichment_job":
{ Args: { "p_error_summary"?: string,"p_job_id": string,"p_status": string }; Returns: undefined
                           },
"finish_github_repository_assessment_job":
{ Args: { "p_job_id": string }; Returns: Json
                           },
"finish_github_repository_assessment_recovery":
{ Args: { "p_job_id": string,"p_worker_id": string }; Returns: Json
                           },
"get_public_catalog_facets":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"heartbeat_catalog_import":
{ Args: { "p_job_id": string,"p_lease_token": string,"p_worker_id": string }; Returns: string
                           },
"list_project_logo_cleanup_attempts":
{ Args: { "p_logo_id": string }; Returns: Json
                           },
"pipeline_operator_report":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"pipeline_operator_report_m2_04_previous":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"pipeline_operator_report_m2_05_previous":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"pipeline_operator_report_v1":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"pipeline_operator_report_v2":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"pipeline_operator_verify_resume":
{ Args: { "p_run_id": string }; Returns: Json
                           },
"pipeline_operator_verify_run":
{ Args: { "p_run_id": string }; Returns: Json
                           },
"register_project_logo_candidate":
{ Args: { "p_attribution_text": string,"p_candidate_key": string,"p_origin": string,"p_project_id": string,"p_repository_id": string,"p_source_observed_at": string,"p_source_provenance": Json,"p_source_record_id": string,"p_source_url": string }; Returns: string
                           },
"release_discovery_partition":
{ Args: { "p_lease_token": string,"p_query_id": string,"p_worker_id": string }; Returns: undefined
                           },
"release_project_logo_approval":
{ Args: { "p_approval_token": string,"p_logo_id": string,"p_worker_id": string }; Returns: Json
                           },
"search_public_projects":
{ Args: { "p_categories"?: (string)[],"p_languages"?: (string)[],"p_licenses"?: (string)[],"p_page"?: number,"p_page_size"?: number,"p_query"?: string,"p_slug"?: string,"p_sort"?: string }; Returns: Json
                           },
"set_project_logo_review_status":
{ Args: { "p_logo_id": string,"p_status": string }; Returns: Json
                           },
"start_catalog_import":
{ Args: { "p_archive_sha256": string,"p_environment": string,"p_lease_token": string,"p_project_ref": string,"p_resume": boolean,"p_total_batches": number,"p_total_candidates": number,"p_worker_id": string }; Returns: Json
                           },
"start_discovery_job":
{ Args: { "p_partitions": Json,"p_plan_name": string,"p_plan_version": string }; Returns: string
                           },
"start_github_enrichment_job":
{ Args: { "p_metadata"?: Json,"p_resume"?: boolean }; Returns: string
                           },
"start_github_repository_assessment_job":
{ Args: { "p_metadata"?: Json,"p_resume"?: boolean }; Returns: string
                           },
"tag_pipeline_ingestion_job":
{ Args: { "p_job_id": string,"p_run_id": string }; Returns: undefined
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const
