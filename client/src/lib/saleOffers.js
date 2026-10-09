// Produits de soumission (offre vendue, sans stock) : vivent dans le Catalogue
// de vente, pas dans Pièces/Produits. Un produit vendable mais physique
// (contrôleur, capteur…) reste aussi dans Pièces/Produits.
export const isSaleOffer = p => !!p?.is_sellable && (!p.type || p.type === 'Service')
