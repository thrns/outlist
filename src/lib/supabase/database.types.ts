
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
                    "candidates_found": number,"created_at": string,"cursor": Json | null,"finished_at": string | null,"id": string,"last_error": string | null,"pages_fetched": number,"partition_key": string,"provider": string,"query_text": string,"started_at": string | null,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "candidates_found"?: number,"created_at"?: string,"cursor"?: Json | null,"finished_at"?: string | null,"id"?: string,"last_error"?: string | null,"pages_fetched"?: number,"partition_key": string,"provider": string,"query_text": string,"started_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "candidates_found"?: number,"created_at"?: string,"cursor"?: Json | null,"finished_at"?: string | null,"id"?: string,"last_error"?: string | null,"pages_fetched"?: number,"partition_key"?: string,"provider"?: string,"query_text"?: string,"started_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
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
                    "created_at": string,"error_summary": string | null,"finished_at": string | null,"id": string,"items_created": number,"items_discovered": number,"items_failed": number,"items_processed": number,"items_skipped": number,"items_updated": number,"job_type": string,"metadata": NonNullable<Json>,"provider": string | null,"started_at": string | null,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"error_summary"?: string | null,"finished_at"?: string | null,"id"?: string,"items_created"?: number,"items_discovered"?: number,"items_failed"?: number,"items_processed"?: number,"items_skipped"?: number,"items_updated"?: number,"job_type": string,"metadata"?: NonNullable<Json>,"provider"?: string | null,"started_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"error_summary"?: string | null,"finished_at"?: string | null,"id"?: string,"items_created"?: number,"items_discovered"?: number,"items_failed"?: number,"items_processed"?: number,"items_skipped"?: number,"items_updated"?: number,"job_type"?: string,"metadata"?: NonNullable<Json>,"provider"?: string | null,"started_at"?: string | null,"status"?: string,"updated_at"?: string
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
                    "attribution_text": string | null,"created_at": string,"id": string,"is_primary": boolean,"media_type": string,"origin": string,"project_id": string,"source_record_id": string | null,"source_url": string,"storage_path": string | null,"updated_at": string,"verification_status": string,"verified_at": string | null,"verified_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attribution_text"?: string | null,"created_at"?: string,"id"?: string,"is_primary"?: boolean,"media_type": string,"origin": string,"project_id": string,"source_record_id"?: string | null,"source_url": string,"storage_path"?: string | null,"updated_at"?: string,"verification_status"?: string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Update: {
                    "attribution_text"?: string | null,"created_at"?: string,"id"?: string,"is_primary"?: boolean,"media_type"?: string,"origin"?: string,"project_id"?: string,"source_record_id"?: string | null,"source_url"?: string,"storage_path"?: string | null,"updated_at"?: string,"verification_status"?: string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_logos_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "project_logos_source_record_id_fkey"
      columns: ["source_record_id"]
isOneToOne: false
      referencedRelation: "source_records"
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
                    "created_at": string,"description": string,"editorial_rank": number,"featured": boolean,"id": string,"last_verified_at": string | null,"license_identifier": string | null,"license_status": string,"license_verified_at": string | null,"name": string,"official_website_url": string | null,"primary_repository_id": string | null,"publication_status": string,"published_at": string | null,"quality_status": string,"search_document": unknown,"slug": string,"summary": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"description"?: string,"editorial_rank"?: number,"featured"?: boolean,"id"?: string,"last_verified_at"?: string | null,"license_identifier"?: string | null,"license_status"?: string,"license_verified_at"?: string | null,"name"?: string,"official_website_url"?: string | null,"primary_repository_id"?: string | null,"publication_status"?: string,"published_at"?: string | null,"quality_status"?: string,"search_document"?: never,"slug": string,"summary"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"description"?: string,"editorial_rank"?: number,"featured"?: boolean,"id"?: string,"last_verified_at"?: string | null,"license_identifier"?: string | null,"license_status"?: string,"license_verified_at"?: string | null,"name"?: string,"official_website_url"?: string | null,"primary_repository_id"?: string | null,"publication_status"?: string,"published_at"?: string | null,"quality_status"?: string,"search_document"?: never,"slug"?: string,"summary"?: string,"updated_at"?: string
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
                    "created_at": string,"id": string,"is_draft": boolean,"is_prerelease": boolean,"provider_release_id": string,"published_at": string | null,"release_name": string | null,"release_url": string,"repository_id": string,"source_record_id": string | null,"updated_at": string,"version": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_draft"?: boolean,"is_prerelease"?: boolean,"provider_release_id": string,"published_at"?: string | null,"release_name"?: string | null,"release_url": string,"repository_id": string,"source_record_id"?: string | null,"updated_at"?: string,"version": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_draft"?: boolean,"is_prerelease"?: boolean,"provider_release_id"?: string,"published_at"?: string | null,"release_name"?: string | null,"release_url"?: string,"repository_id"?: string,"source_record_id"?: string | null,"updated_at"?: string,"version"?: string
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
                    "availability_status": string,"canonical_url": string,"created_at": string,"default_branch": string | null,"description": string | null,"forks": number,"full_name": string,"id": string,"is_archived": boolean,"is_fork": boolean,"last_successful_sync_at": string | null,"primary_language": string | null,"project_id": string | null,"provider": string,"provider_created_at": string | null,"provider_pushed_at": string | null,"provider_repository_id": string,"provider_updated_at": string | null,"stars": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "availability_status"?: string,"canonical_url": string,"created_at"?: string,"default_branch"?: string | null,"description"?: string | null,"forks"?: number,"full_name": string,"id"?: string,"is_archived"?: boolean,"is_fork"?: boolean,"last_successful_sync_at"?: string | null,"primary_language"?: string | null,"project_id"?: string | null,"provider": string,"provider_created_at"?: string | null,"provider_pushed_at"?: string | null,"provider_repository_id": string,"provider_updated_at"?: string | null,"stars"?: number,"updated_at"?: string
                  }
                  Update: {
                    "availability_status"?: string,"canonical_url"?: string,"created_at"?: string,"default_branch"?: string | null,"description"?: string | null,"forks"?: number,"full_name"?: string,"id"?: string,"is_archived"?: boolean,"is_fork"?: boolean,"last_successful_sync_at"?: string | null,"primary_language"?: string | null,"project_id"?: string | null,"provider"?: string,"provider_created_at"?: string | null,"provider_pushed_at"?: string | null,"provider_repository_id"?: string,"provider_updated_at"?: string | null,"stars"?: number,"updated_at"?: string
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
                },"repository_candidates": {
                  Row: {
                    "attempts": number,"canonical_url": string,"completed_at": string | null,"created_at": string,"discovery_query_id": string | null,"first_seen_at": string,"full_name": string,"id": string,"last_error": string | null,"last_seen_at": string,"lock_owner": string | null,"locked_at": string | null,"max_attempts": number,"next_attempt_at": string | null,"provider": string,"provider_repository_id": string,"queue_status": string,"repository_id": string | null,"source_record_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"canonical_url": string,"completed_at"?: string | null,"created_at"?: string,"discovery_query_id"?: string | null,"first_seen_at"?: string,"full_name": string,"id"?: string,"last_error"?: string | null,"last_seen_at"?: string,"lock_owner"?: string | null,"locked_at"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"provider": string,"provider_repository_id": string,"queue_status"?: string,"repository_id"?: string | null,"source_record_id": string,"updated_at"?: string
                  }
                  Update: {
                    "attempts"?: number,"canonical_url"?: string,"completed_at"?: string | null,"created_at"?: string,"discovery_query_id"?: string | null,"first_seen_at"?: string,"full_name"?: string,"id"?: string,"last_error"?: string | null,"last_seen_at"?: string,"lock_owner"?: string | null,"locked_at"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"provider"?: string,"provider_repository_id"?: string,"queue_status"?: string,"repository_id"?: string | null,"source_record_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_candidates_discovery_query_id_fkey"
      columns: ["discovery_query_id"]
isOneToOne: false
      referencedRelation: "discovery_queries"
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
                    "assigned_to": string | null,"created_at": string,"id": string,"project_alternative_id": string | null,"project_id": string | null,"project_logo_id": string | null,"reason": string,"repository_id": string | null,"resolved_at": string | null,"status": string,"submission_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assigned_to"?: string | null,"created_at"?: string,"id"?: string,"project_alternative_id"?: string | null,"project_id"?: string | null,"project_logo_id"?: string | null,"reason": string,"repository_id"?: string | null,"resolved_at"?: string | null,"status"?: string,"submission_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "assigned_to"?: string | null,"created_at"?: string,"id"?: string,"project_alternative_id"?: string | null,"project_id"?: string | null,"project_logo_id"?: string | null,"reason"?: string,"repository_id"?: string | null,"resolved_at"?: string | null,"status"?: string,"submission_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
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
                    "created_at": string,"fetched_at": string,"http_status": number | null,"id": string,"provider": string,"raw_payload": Json | null,"record_kind": string,"repository_id": string | null,"reuse_context": string | null,"source_key": string,"source_url": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"fetched_at": string,"http_status"?: number | null,"id"?: string,"provider": string,"raw_payload"?: Json | null,"record_kind": string,"repository_id"?: string | null,"reuse_context"?: string | null,"source_key": string,"source_url": string
                  }
                  Update: {
                    "created_at"?: string,"fetched_at"?: string,"http_status"?: number | null,"id"?: string,"provider"?: string,"raw_payload"?: Json | null,"record_kind"?: string,"repository_id"?: string | null,"reuse_context"?: string | null,"source_key"?: string,"source_url"?: string
                  }
                  Relationships: [
                    {
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
            [_ in never]: never
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
