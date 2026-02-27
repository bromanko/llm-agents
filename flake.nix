{
  description = "Pi extensions, skills, and tools";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.selfci
          ];
        };

        lsp-test = pkgs.mkShell {
          packages = [
            pkgs.selfci
            pkgs.nodePackages.typescript-language-server
            pkgs.nodePackages.typescript
          ];
        };
      });
    };
}
