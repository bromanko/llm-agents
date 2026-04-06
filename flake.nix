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

      # marksman's Nix wrapper sets LD_LIBRARY_PATH for ICU, but macOS needs
      # DYLD_LIBRARY_PATH (which SIP strips anyway). Work around the .NET ICU
      # lookup failure by enabling invariant globalization mode.
      fixMarksman =
        pkgs:
        if pkgs.stdenv.hostPlatform.isDarwin then
          pkgs.marksman.overrideAttrs (old: {
            postFixup = (old.postFixup or "") + ''
              wrapProgram $out/bin/marksman \
                --set DOTNET_SYSTEM_GLOBALIZATION_INVARIANT 1
            '';
          })
        else
          pkgs.marksman;
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.selfci

            # LSP servers
            pkgs.typescript-language-server
            pkgs.typescript
            pkgs.nil # Nix
            pkgs.bash-language-server
            pkgs.yaml-language-server
            pkgs.vscode-json-languageserver
            (fixMarksman pkgs) # Markdown
          ];
        };

        lsp-test = pkgs.mkShell {
          packages = [
            pkgs.selfci
            pkgs.typescript-language-server
            pkgs.typescript
          ];
        };
      });
    };
}
