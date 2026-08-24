/**
 * Remplaçant de `server-only` sous Vitest.
 *
 * Le paquet réel n'exporte rien : il lève à l'import dès qu'il n'est pas
 * résolu par la condition d'export « react-server » du bundler Next. C'est
 * exactement ce qu'on veut au build — et exactement ce qui empêcherait de
 * tester une couche de lecture qui s'en protège.
 *
 * Ce fichier ne désactive donc aucune garde : il rend seulement le module
 * importable dans un runtime Node nu, où la notion de Client Component
 * n'existe pas.
 */
export {};
