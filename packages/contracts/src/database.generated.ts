export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      owner_payment_recipients: {
        Row: {
          created_at: string;
          owner_user_id: string;
          profile_version_synced: number | null;
          recipient_version: number;
          requirements: string[];
          status: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          owner_user_id: string;
          profile_version_synced?: number | null;
          recipient_version?: number;
          requirements?: string[];
          status?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          owner_user_id?: string;
          profile_version_synced?: number | null;
          recipient_version?: number;
          requirements?: string[];
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "owner_payment_recipients_owner_user_id_fkey";
            columns: ["owner_user_id"];
            isOneToOne: true;
            referencedRelation: "owner_profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      owner_profiles: {
        Row: {
          accepted_owner_contract_version_id: string;
          activated_at: string;
          created_at: string;
          owner_version: number;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          accepted_owner_contract_version_id: string;
          activated_at?: string;
          created_at?: string;
          owner_version?: number;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          accepted_owner_contract_version_id?: string;
          activated_at?: string;
          created_at?: string;
          owner_version?: number;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "owner_profiles_accepted_owner_contract_version_id_fkey";
            columns: ["accepted_owner_contract_version_id"];
            isOneToOne: false;
            referencedRelation: "terms_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "owner_profiles_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          additional_document: string | null;
          additional_document_masked: string | null;
          completed_at: string | null;
          created_at: string;
          id: string;
          name: string | null;
          person_type: string;
          phone_e164: string | null;
          profile_version: number;
          status: string;
          tax_id: string | null;
          tax_id_masked: string | null;
          updated_at: string;
        };
        Insert: {
          additional_document?: string | null;
          additional_document_masked?: string | null;
          completed_at?: string | null;
          created_at?: string;
          id: string;
          name?: string | null;
          person_type: string;
          phone_e164?: string | null;
          profile_version?: number;
          status?: string;
          tax_id?: string | null;
          tax_id_masked?: string | null;
          updated_at?: string;
        };
        Update: {
          additional_document?: string | null;
          additional_document_masked?: string | null;
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          name?: string | null;
          person_type?: string;
          phone_e164?: string | null;
          profile_version?: number;
          status?: string;
          tax_id?: string | null;
          tax_id_masked?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      studio_revisions: {
        Row: {
          address_complement: string | null;
          capacity: number;
          city: string;
          created_at: string;
          description: string;
          id: string;
          name: string;
          neighborhood: string;
          postal_code: string;
          revision_number: number;
          state: string;
          status: string;
          street: string;
          street_number: string;
          studio_id: string;
          studio_type_id: string;
          updated_at: string;
        };
        Insert: {
          address_complement?: string | null;
          capacity: number;
          city?: string;
          created_at?: string;
          description: string;
          id?: string;
          name: string;
          neighborhood: string;
          postal_code: string;
          revision_number: number;
          state?: string;
          status?: string;
          street: string;
          street_number: string;
          studio_id: string;
          studio_type_id: string;
          updated_at?: string;
        };
        Update: {
          address_complement?: string | null;
          capacity?: number;
          city?: string;
          created_at?: string;
          description?: string;
          id?: string;
          name?: string;
          neighborhood?: string;
          postal_code?: string;
          revision_number?: number;
          state?: string;
          status?: string;
          street?: string;
          street_number?: string;
          studio_id?: string;
          studio_type_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "studio_revisions_studio_id_fkey";
            columns: ["studio_id"];
            isOneToOne: false;
            referencedRelation: "studios";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "studio_revisions_studio_type_id_fkey";
            columns: ["studio_type_id"];
            isOneToOne: false;
            referencedRelation: "studio_types";
            referencedColumns: ["id"];
          },
        ];
      };
      studio_types: {
        Row: {
          active: boolean;
          created_at: string;
          description: string | null;
          id: string;
          name: string;
          slug: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          description?: string | null;
          id?: string;
          name: string;
          slug: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          description?: string | null;
          id?: string;
          name?: string;
          slug?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      studios: {
        Row: {
          created_at: string;
          draft_revision_id: string | null;
          edit_version: number;
          id: string;
          last_revision_number: number;
          owner_user_id: string;
          published_revision_id: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          draft_revision_id?: string | null;
          edit_version?: number;
          id: string;
          last_revision_number?: number;
          owner_user_id: string;
          published_revision_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          draft_revision_id?: string | null;
          edit_version?: number;
          id?: string;
          last_revision_number?: number;
          owner_user_id?: string;
          published_revision_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "studios_draft_revision_fk";
            columns: ["id", "draft_revision_id"];
            isOneToOne: false;
            referencedRelation: "studio_revisions";
            referencedColumns: ["studio_id", "id"];
          },
          {
            foreignKeyName: "studios_owner_user_id_fkey";
            columns: ["owner_user_id"];
            isOneToOne: false;
            referencedRelation: "owner_profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "studios_published_revision_fk";
            columns: ["id", "published_revision_id"];
            isOneToOne: false;
            referencedRelation: "studio_revisions";
            referencedColumns: ["studio_id", "id"];
          },
        ];
      };
      terms_acceptances: {
        Row: {
          accepted_at: string;
          accepted_content_hash: string;
          ip_hash: string | null;
          request_id: string;
          terms_version_id: string;
          user_agent_hash: string | null;
          user_id: string;
        };
        Insert: {
          accepted_at: string;
          accepted_content_hash: string;
          ip_hash?: string | null;
          request_id: string;
          terms_version_id: string;
          user_agent_hash?: string | null;
          user_id: string;
        };
        Update: {
          accepted_at?: string;
          accepted_content_hash?: string;
          ip_hash?: string | null;
          request_id?: string;
          terms_version_id?: string;
          user_agent_hash?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "terms_acceptances_terms_version_id_fkey";
            columns: ["terms_version_id"];
            isOneToOne: false;
            referencedRelation: "terms_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "terms_acceptances_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      terms_versions: {
        Row: {
          body_markdown: string;
          content_hash: string | null;
          created_at: string;
          effective_at: string;
          id: string;
          kind: string;
          retired_at: string | null;
          source: string;
          title: string;
          version: string;
        };
        Insert: {
          body_markdown: string;
          content_hash?: string | null;
          created_at?: string;
          effective_at: string;
          id?: string;
          kind: string;
          retired_at?: string | null;
          source: string;
          title: string;
          version: string;
        };
        Update: {
          body_markdown?: string;
          content_hash?: string | null;
          created_at?: string;
          effective_at?: string;
          id?: string;
          kind?: string;
          retired_at?: string | null;
          source?: string;
          title?: string;
          version?: string;
        };
        Relationships: [];
      };
      user_preferences: {
        Row: {
          color_scheme: string;
          created_at: string;
          preferences_version: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          color_scheme?: string;
          created_at?: string;
          preferences_version?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          color_scheme?: string;
          created_at?: string;
          preferences_version?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_preferences_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      get_current_legal_terms: {
        Args: never;
        Returns: {
          body_markdown: string;
          content_hash: string;
          effective_at: string;
          id: string;
          kind: string;
          source: string;
          title: string;
          version: string;
        }[];
      };
      get_current_owner_contract: {
        Args: never;
        Returns: {
          body_markdown: string;
          content_hash: string;
          effective_at: string;
          id: string;
          kind: string;
          source: string;
          title: string;
          version: string;
        }[];
      };
      get_my_profile: {
        Args: never;
        Returns: {
          additional_document_masked: string;
          color_scheme: string;
          name: string;
          person_type: string;
          phone_e164: string;
          preferences_version: number;
          profile_completed: boolean;
          profile_version: number;
          status: string;
          tax_id_masked: string;
          user_id: string;
        }[];
      };
      get_own_identity_context: {
        Args: never;
        Returns: {
          is_complete: boolean;
          person_type: string;
          status: string;
          user_id: string;
        }[];
      };
      get_owner_activation_status: {
        Args: never;
        Returns: {
          accepted_owner_contract_version_id: string;
          next_action: string;
          owner_contract_accepted: boolean;
          owner_contract_body_markdown: string;
          owner_contract_content_hash: string;
          owner_contract_effective_at: string;
          owner_contract_id: string;
          owner_contract_kind: string;
          owner_contract_source: string;
          owner_contract_title: string;
          owner_contract_version: string;
          owner_status: string;
          owner_version: number;
          profile_version: number;
          profile_version_synced: number;
          provider_mode: string;
          recipient_status: string;
          recipient_version: number;
          requirements: string[];
          reservations_eligible: boolean;
          scope: string;
        }[];
      };
      get_owner_recipient_status: {
        Args: never;
        Returns: {
          accepted_owner_contract_version_id: string;
          next_action: string;
          owner_contract_accepted: boolean;
          owner_contract_effective_at: string;
          owner_contract_id: string;
          owner_contract_source: string;
          owner_status: string;
          owner_version: number;
          profile_version: number;
          profile_version_synced: number;
          provider_mode: string;
          recipient_status: string;
          recipient_version: number;
          requirements: string[];
          reservations_eligible: boolean;
          scope: string;
        }[];
      };
      get_owner_studio_editor: {
        Args: { p_studio_id: string };
        Returns: {
          draft_address_complement: string;
          draft_capacity: number;
          draft_city: string;
          draft_description: string;
          draft_name: string;
          draft_neighborhood: string;
          draft_postal_code: string;
          draft_revision_id: string;
          draft_revision_number: number;
          draft_state: string;
          draft_street: string;
          draft_street_number: string;
          draft_studio_type_id: string;
          draft_studio_type_name: string;
          edit_version: number;
          published_address_complement: string;
          published_capacity: number;
          published_city: string;
          published_description: string;
          published_name: string;
          published_neighborhood: string;
          published_postal_code: string;
          published_revision_id: string;
          published_revision_number: number;
          published_state: string;
          published_street: string;
          published_street_number: string;
          published_studio_type_id: string;
          published_studio_type_name: string;
          scope: string;
          studio_id: string;
          studio_status: string;
        }[];
      };
      list_active_studio_types: {
        Args: never;
        Returns: {
          id: string;
          name: string;
        }[];
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
