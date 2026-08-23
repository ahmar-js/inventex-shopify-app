import db from "../db.server";

export async function deleteAllShopData(shop: string) {
  await db.$transaction([
    db.alertQueue.deleteMany({ where: { shop } }),
    db.alertSent.deleteMany({ where: { shop } }),
    db.alertSettings.deleteMany({ where: { shop } }),
    db.collectionAutoSorting.deleteMany({ where: { shop } }),
    db.collectionRule.deleteMany({ where: { shop } }),
    db.excludedProduct.deleteMany({ where: { shop } }),
    db.productAvailabilityState.deleteMany({ where: { shop } }),
    db.inventoryState.deleteMany({ where: { shop } }),
    db.shopSettings.deleteMany({ where: { shop } }),
    db.job.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);
}
