# plugins/fixture_alpha

Proof package for the schema role and the codegen boundary (ADR-0008, plan K17).

The id is `fixture_alpha`. The schema name is derived: `plugin_fixture_alpha`. The package asks for `db.own_schema` and lists no `directory.write_edge:<type>` grant, so it registers no edge type. The table `note` is tenant-scoped. It is not a product plugin and it does not enter the kernel `Database` interface.
