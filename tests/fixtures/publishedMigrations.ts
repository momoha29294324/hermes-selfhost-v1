/**
 * L'EMPREINTE de chaque migration livrée, gelée à la publication.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier empêche
 * ---------------------------------------------------------------------------
 * Le runner refuse une migration dont l'empreinte a changé depuis qu'elle a été
 * appliquée : c'est ce qui garantit qu'une base et le code qui l'a construite
 * racontent la même histoire. La conséquence tient en une phrase, et elle n'est
 * évidente qu'une fois qu'on l'a payée : **modifier un fichier de migration
 * déjà publié casse la mise à jour de TOUTE instance qui l'a appliqué.**
 *
 * Un commentaire suffit. Corriger une faute de frappe dans un `--` en tête de
 * `0014` ne change rien à ce que la migration FAIT, et empêche pourtant
 * `npm run db:migrate` de passer chez tous ceux qui tournent déjà. Ce n'est pas
 * une hypothèse : c'est arrivé pendant la préparation de cette version, et
 * c'est ce fichier qui l'a rendu visible avant la publication plutôt qu'après.
 *
 * ---------------------------------------------------------------------------
 * Comment on le tient à jour
 * ---------------------------------------------------------------------------
 * Une migration NOUVELLE s'ajoute ici avec son empreinte, en fin de liste.
 * Une migration EXISTANTE ne change jamais de valeur : si le test échoue,
 * la réponse est de restaurer le fichier, pas de recopier la nouvelle
 * empreinte. Le seul cas où une ligne existante bouge légitimement est la
 * suppression pure et simple d'une migration jamais publiée.
 *
 * L'empreinte est calculée exactement comme le runner la calcule
 * (`src/lib/db/migrate.ts`) : SHA-256 du fichier, tronqué à 32 caractères.
 */
export const PUBLISHED_MIGRATION_CHECKSUMS: Readonly<Record<string, string>> = Object.freeze({
  "0001_init": "238318d89e1b75b31e19558f70199445",
  "0002_case_studies": "296ff562efd7ff16e139c71c55952442",
  "0003_places_first_discovery": "edfa5bdc7fa2685101e71ad7dc9815bf",
  "0004_places_pointer_only": "c848dab9b10b2346e8a31922a1a3a143",
  "0005_places_resolution_levels": "f5ad0752e9b9f502237dcd617d0e8a0d",
  "0006_r3_open_web_discovery": "16d6da2111364464fd19f779a236137f",
  "0007_domain_candidate_origin_observed": "528b36353b43b7c809e31bef5be4bf2d",
  "0008_r4_search_provider": "9d68e837d18a13c7c0e3aeee4c6bbd3c",
  "0009_r5_commercial_discovery": "e0601472ad38e2070a4acd04829fcbbd",
  "0010_r51_llm_instrumentation": "7e17470dd4741b82272cebfd9de00deb",
  "0011_human_blind_review": "d7c2cac176325cb62965b9c3578293b8",
  "0012_r6a1_copy_review": "173c102ea72b3dfb337c4f67d0c18088",
  "0013_r6a2_copy_review": "c0934ba907b779308687a1787ed046c3",
  "0014_r6a2b_humanized_review": "1b9edbd77b02e404b44db48c76f59de6",
  "0015_r6a2c_bridge_review": "28ab7719427ea2535ed094d88e87845c",
  "0016_r6a3_final5_review": "11bba366d8e488e55002fc60b0359f51",
  "0017_r6a4_final_human_review": "b4180a3921d3792feabecd1efdf00daf",
  "0018_r6b_assisted_pilot": "08633045849fb12e05044292116c4541",
  "0019_r6b_dispatch_manifest": "f63c259b612f109c07b81591a6221b67",
  "0020_r6b_transport_normalization": "5a44e7b82d288f1bcbbd58d4db24cb8a",
  "0021_r6b_dispatch_attempts": "64100f3f518904906b0198fab83fc21b",
  "0022_r6b_transport_payload": "7a0a556482e2c18f4a82e618c31fb682",
  "0023_r6b_live_email_gate": "619368102d43357a4474584c9b3ae181",
  "0024_r6b_provider_payload_identity": "78e67179a4758e7b8e18e463f393f046",
  "0025_r6b_inbound_reply_intake": "1a5a0b01b847ea7c1eaf508788a8d45f",
  "0026_r6b_reply_intelligence": "7dcead59d68f3452143b4f6b325b66fc",
  "0027_r6b_crm_destination": "a3c3b94f40adf8a34da2fde9a869ca19",
  "0028_crm_local_canonical": "6eda4e08ccd8f4772aba95772b04c8fb",
  "0029_instagram_dispatch_rail": "15713b5ad3fd1cec9d4e073eb6e8b520",
  "0030_icp_eligibility": "7c90903b0dfa966aeaa6d10e8206f9c3",
  "0031_instagram_live_canary": "26e4587671e6e5be641817953be17cbc",
  "0032_instagram_canary_retry_before_effect": "928b711b41981be2493c417a0be7092a",
  "0033_instagram_canary_adjudication": "3295518bc45bc8e71ee412d7536a04c9",
  "0034_instagram_canary_reservation": "d659f2800e0c915b21ce87d947c79838",
  "0035_instagram_controlled_test": "1947b4ee9e2a483a173db877db1122d1",
  "0036_instagram_controlled_test_own_profile": "afa19f72060f889ad54db6281b7e57c3",
  "0037_instagram_controlled_test_compose_check": "cae2f9c1215c43b9e704fba6ed7f9dc1",
  "0038_instagram_adjudication_observation": "325d8e30d27054a995e1bcbb2f4685ef",
  "0039_instagram_ig3_queue_scheduling": "273c018d0c0bb3c41941aa559805f414",
  "0040_channel_identity_human_confirmation": "20aacd43a0e8ee7b848397dc81672a69",
  "0041_r6b_batch_identity_contact_history": "c5e540d887c993cffd008d40b14e34fa",
  "0042_ig5_instagram_inbound": "e514963db3a745a997dffa988e1abefc",
  "0043_ig5_r3_network_message_source": "dec99d727dec8b1850a073c298be80a2",
  "0044_ig5_r3_provider_message_id_is_opaque": "e89c937dae7447b85767abd961166e06",
  "0045_ig5_r3_no_outreach_is_not_a_reply": "c0a3170913df5983b41101cf9b44e18a",
  "0046_audience_scale_gate": "83f1155f4bd58b64881d5074c0476da8",
  "0047_autonomous_approval_provenance": "c6bea308be949c4710c6a7b3d9157656",
  "0048_reply_ordering_watermark": "3d69a3e72c3e4c90e05046c8fd9877eb",
  "0049_hermes_conversation_r2": "db17c8cf11c008e5168cabd7744e2a1f",
  "0050_hermes_reply_delivery_r1": "604d5108bff4b8f46669e7c66e791e6c",
  "0051_identity_rename_reingestion_repair": "657aa7ec2e0aea18aa08cde6d6756415",
  "0052_service_scope_targeting": "7cb12cc6955bba6fed1ca8eb132079d1",
  "0053_hermes_booking_mechanism_r1": "25b6579e77b3b005ac14d228c97ccd2f",
  "0054_reply_information_shared": "4c3ab7fa2c758d6a368e0d9de6b5e268",
  "0055_reply_draft_prompt_version": "5648f1b76ff3449b7d71adf100914e7e",
  "0056_analysis_operator_retirement": "e6bc5f6863b358a06b29d5ff9cd390ae",
  "0057_reply_analysis_semantic_scope": "72526f0b2dc4452a498caced8d05deb1",
  "0058_inbound_burst_absorption": "23dcd9dd848a60f9d667f30fe65d1d9e",
  "0059_autoreply_production_activation": "dd506abda302eb01d740abe8482fecd4",
  "0060_firsttouch_bounded_activation": "a8fcc3a625f27f57c1d2a11be34bb3b5",
  "0061_manifest_operator_retirement": "e8ddea9f42cfbe7cadf2c3a8f5639e21",
  "0062_hermes_native_booking_r1": "bc6c1673e5e89c657ad7da88e0887800",});
