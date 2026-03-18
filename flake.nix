{
  description = "Tauri Chess Coach development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      # Assuming you are on a standard 64-bit Linux machine
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        nativeBuildInputs = with pkgs; [
          pkg-config
          cargo
          rustc
          nodejs
        ];

        buildInputs = with pkgs; [
          dbus
          glib
          gtk3
          librsvg
          libsoup_3
          openssl
          webkitgtk_4_1
        ];
      };
    };
}
