const jwt = require('jsonwebtoken');
const db = require("../../models");
const helper = require("../../config/helper");
const mongoose = require('mongoose');
const axios = require('axios');
const { SellBusiness, SavedDeal, BusinessType, Sector,Business } = require('../../models');
const { processSearchQuery } = require('../../service/searchServices')
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {

    getBusinessTypes: async (req, res) => {
        try {
            const data = await BusinessType.find();
            return helper.success(res, "Business types list retrieved successfully", data);
        } catch (err) {
            return helper.error(res, err);
        }
    },
    businesses: async (req, res) => {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const { name, businessTypeId, general_summary, status_of_business, property_status, is_real_property_included, is_active = true, quick_sale, photographs, documents, website_address, years_established, reason_for_selling, description, sellerEmail, region, city_town, location, asking_price, sales_revenue, cash_flow, sectorId } = req.body;

            if (!name || !businessTypeId) {
                return helper.error(res, 'Business name and business type are required.');
            }

            const newBusiness = new SellBusiness({
                name,
                businessTypeId,
                general_summary,
                status_of_business,
                property_status,
                is_real_property_included,
                is_active,
                sectorId,
                quick_sale,
                photographs,
                documents,
                website_address,
                years_established,
                reason_for_selling,
                description,
                sellerEmail,
                region: region,
                city_town: city_town,
                location: location,
                asking_price: asking_price,
                sales_revenue: sales_revenue,
                cash_flow: cash_flow,
            });

            await newBusiness.save({ session });
            await session.commitTransaction();
            session.endSession();

            return helper.success(res, 'Business added successfully', newBusiness);
        } catch (error) {
            await session.abortTransaction();
            session.endSession();
            console.error('Error adding business:', error);
            return helper.error(res, 'Error adding business');
        }
    },
    //------
    getBusinesses: async (req, res) => {
        try {
            const { offset = 0, limit = 10, search, orderBy = 'desc', business_type, sector, revenue_price, asking_price } = req.query;
            const sortOrder = orderBy.toLowerCase() === 'asc' ? 1 : -1;

            // Base condition
            let condition = { is_active: true };

            // if (search) {
            //     const { name, location } = await processSearchQuery(search);
            //     console.log('name===',name,'location===',location);
    
            //     if (name) {
            //         condition.name = { $regex: name, $options: 'i' };
            //     }
            //     if (location) {
            //         condition.$or = [
            //             { location: { $regex: location, $options: 'i' } },
            //             { city_town: { $regex: location, $options: 'i' } },
            //             { region: { $regex: location, $options: 'i' } },
            //         ];
            //     }
            // }
            if (search) {
                condition.$text = { $search: search };
            }


            // Additional filters
            if (sector) {
                condition.sectorId = new mongoose.Types.ObjectId(`${sector}`);
            }

            if (business_type) {
                condition.businessTypeId = new mongoose.Types.ObjectId(`${business_type}`);
            }

            // Revenue Range filter (e.g., "100-2000")
            if (revenue_price) {
                if (revenue_price === '0') {
                    condition.sales_revenue = 0;
                } else {
                    const [revenueMin, revenueMax] = revenue_price.split('-').map(Number);
                    condition.sales_revenue = {
                        ...(revenueMin >= 0 && { $gte: revenueMin }),
                        ...(revenueMax > 0 && { $lte: revenueMax }),
                    };
                }
            }

            // Asking Price Range filter (e.g., "100-3000")
            if (asking_price) {
                if (asking_price === '0') {
                    condition.asking_price = 0;
                } else {
                    const [askingMin, askingMax] = asking_price.split('-').map(Number);
                    condition.asking_price = {
                        ...(askingMin >= 0 && { $gte: askingMin }),
                        ...(askingMax > 0 && { $lte: askingMax }),
                    };
                }
            }

            // Aggregation pipeline
            const aggregationData = [
                { $match: condition }, // Match condition earlier for optimization
                {
                    $lookup: {
                        from: "businesstypes",
                        localField: "businessTypeId",
                        foreignField: "_id",
                        as: "business_type",
                        pipeline: [{ $project: { name: 1 } }]
                    },
                },
                {
                    $lookup: {
                        from: "sectors",
                        localField: "sectorId",
                        foreignField: "_id",
                        as: "sector",
                        pipeline: [{ $project: { name: 1 } }]
                    },
                },
                {
                    $unwind: { path: "$business_type", preserveNullAndEmptyArrays: true },
                },
                {
                    $unwind: { path: "$sector", preserveNullAndEmptyArrays: true },
                },
                {
                    $lookup: {
                        from: "saveddeals",
                        localField: "_id",
                        foreignField: "deal_id",
                        as: "savedDeals",
                        pipeline: [{ $match: { user_id: req.user._id } }],
                    },
                },
                {
                    $addFields: {
                        is_saved: {
                            $cond: {
                                if: { $gt: [{ $size: "$savedDeals" }, 0] },
                                then: 1,
                                else: 0
                            }
                        }
                    },
                },
                {
                    $project: {
                        savedDeals: 0,
                    },
                },
                { $sort: { createdAt: sortOrder } },
                { $skip: Number(offset) },
                { $limit: Number(limit) },
            ];

            // Execute aggregation
            const Business = await SellBusiness.aggregate(aggregationData);

            // Get total count for pagination
            const totalCountPipeline = [
                { $match: condition },
                { $count: "totalCount" },
            ];
            const totalCountResult = await SellBusiness.aggregate(totalCountPipeline);
            const totalCount = totalCountResult[0]?.totalCount || 0;

            // Return response
            return helper.success(res, 'Businesses retrieved successfully', {
                totalCount,
                totalPages: Math.ceil(totalCount / limit),
                currentPage: Math.floor(offset / limit) + 1,
                Business
            });
        } catch (error) {
            console.error('Error retrieving businesses:', error);
            return helper.error(res, 'Error retrieving businesses', error);
        }
    },

    getBusinessDetailsById: async (req, res) => {
        try {
            const { id } = req.params;
            // const business = await SellBusiness.findById(id).populate("businessTypeId", "name")
            const business = await SellBusiness.aggregate([
                { $match: { _id: new mongoose.Types.ObjectId(`${id}`) } },
                {
                    $lookup: {
                        from: "businesstypes", // The collection name for SavedDeal
                        localField: "businessTypeId",
                        foreignField: "_id",
                        as: "business_type",
                        pipeline: [
                            {
                                $project: {
                                    name: 1,
                                    description: 1,
                                }
                            }
                        ]
                    }
                },
                {
                    $unwind: { path: "$business_type" }
                },
                {
                    $lookup: {
                        from: "saveddeals", // The collection name for SavedDeal
                        localField: "_id",
                        foreignField: "deal_id",
                        as: "savedDeals",
                        pipeline: [
                            { $match: { user_id: req.user._id } },
                        ],
                    },
                },
                {
                    $addFields: {
                        is_saved: {
                            $cond: {
                                if: { $gt: [{ $size: "$savedDeals" }, 0] },
                                then: 1,
                                else: 0
                            }
                        }
                    },
                },
                {
                    $project: {
                        savedDeals: 0
                    }
                }
            ]);
            if (!business) {
                return helper.error(res, 'Business not found', 404);
            }
            return helper.success(res, 'Business details retrieved successfully', business[0]);
        } catch (error) {
            console.error('Error retrieving business details:', error);
            return helper.error(res, 'Error retrieving business details', error);
        }
    },
    saveDeal: async (req, res) => {
        try {
            const deal_id = req.body.deal_id;

            const existDeal = await SavedDeal.findOne({ deal_id: deal_id, user_id: req.user._id });
            if (existDeal) {
                return helper.error(res, 'Deal already saved. Please select another deal.');
            }

            const savedDeal = new SavedDeal({ deal_id, user_id: req.user._id });
            await savedDeal.save();
            return helper.success(res, 'Deal saved successfully');
        } catch (error) {
            console.log(error)
            return helper.error(res, 'Error saving deal', error);
        }
    },
    removeDeal: async (req, res) => {
        try {
            const { deal_id } = req.query;
            const existDeal = await SavedDeal.findOne({ deal_id: deal_id, user_id: req.user._id });
            if (!existDeal) {
                return helper.error(res, 'Deal not found. Cannot delete.');
            }
            await SavedDeal.findOneAndDelete({ deal_id: deal_id, user_id: req.user._id });
            return helper.success(res, 'Deal removed successfully');
        } catch (error) {
            return helper.error(res, 'Error removing deal', error);
        }
    },
    getDeals: async (req, res) => {
        try {
            const { offset = 0, limit = 10 } = req.query;

            const savedDeals = await SavedDeal.find({ user_id: req.user._id }, { deal_id: 1, _id: 0 }).exec();

            const dealIdsArray = savedDeals.map(deal => deal.deal_id);

            const deals = await SellBusiness.aggregate([
                { $match: { _id: { $in: savedDeals.map(id => new mongoose.Types.ObjectId(`${id.deal_id}`)) } } },
                {
                    $lookup: {
                        from: "businesstypes", // The collection name for SavedDeal
                        localField: "businessTypeId",
                        foreignField: "_id",
                        as: "business_type",
                        pipeline: [
                            {
                                $project: {
                                    name: 1,
                                }
                            }
                        ]
                    },
                },
                { $unwind: { path: "$business_type", } },
                { $skip: Number(offset) },
                { $limit: Number(limit) },
                { $sort: { createdAt: -1 } }
            ]);

            const totalCount = await SellBusiness.countDocuments({ _id: { $in: dealIdsArray } });
            const data = { totalCount: totalCount, totalPages: Math.ceil(totalCount / limit), currentPage: Math.floor(offset / limit) + 1, deals: deals };
            return helper.success(res, 'Deals retrieved successfully', data);
        } catch (error) {
            return helper.error(res, 'Error fetching deals', error);
        }
    },
    editBusiness: async (req, res) => {
        try {
            const id = req.body.id

            const data = await SellBusiness.findByIdAndUpdate(id, {
                $set: req.body
            });
            return helper.success(res, 'Business updated successfully');
        } catch (err) {
            return helper.error(res, err);
        }
    },
    deleteBusiness: async (req, res) => {
        try {
            const { id } = req.params
            const data = await SellBusiness.findByIdAndDelete(id);
            if (!data) {
                return helper.error(res, 'Business not found');
            }
            return helper.success(res, 'Business deleted successfully');
        } catch (err) {
            return helper.error(res, err);
        }
    },
    addSector: async (req, res) => {
        try {
            const { name, parentId } = req.body;
            if (!name) {
                return helper.error(res, "Sector name is required");
            }
            const newSector = new Sector({
                name,
                parentId: parentId || null,
            });
            const savedSector = await newSector.save();
            return helper.success(res, "Sector added successfully", savedSector);
        } catch (err) {
            return helper.error(res, err);
        }
    },
    sectorList: async (req, res) => {
        try {
            const { id } = req.query;
            const filter = id ? { parentId: id } : { parentId: null };
            const data = await Sector.find(filter);
            return helper.success(res, "Sector list retrieved successfully", data);
        } catch (err) {
            return helper.error(res, err);
        }
    },
    updateDataFromApiBusinesses : async (req, res) => {
        try {
            let currentPage = 2;
            const totalPages = 10;
            console.log(`Starting data fetching from List API with ${totalPages} pages`);
            while (currentPage <= totalPages) {
                console.log(`Fetching page ${currentPage} from List API...`);
                const config = {
                    method: 'get',
                    maxBodyLength: Infinity,
                    url: `https://app.skarp.ai/api/listings?page=${currentPage}`, // Dynamically update page number
                    headers: {
                        'Authorization': 'Bearer DDLZUm_.AzbHBqzzer7ZyvkXFx_$7fex',
                    },
                };
                // Fetch List API data
                const response = await axios.request(config);
                const businesses = response.data.items; // Assuming the data structure has items
                console.debug(`Page ${currentPage} fetched. Total listings: ${businesses.length}`);
                for (let business of businesses) {
                    // Create a new business entry using the list data
                    const newBusiness = new Business({
                        businessId: business.id,
                        data: business
                    });
                    // Save to MongoDB
                    await newBusiness.save();
                    console.debug(`Business with ID ${newBusiness.businessId} saved successfully.`);
                }
    
                // Wait for 5 seconds before the next page request
                await delay(8000);
                currentPage++; // Move to the next page
            }
    
            return res.status(200).json({ message: 'Businesses added successfully.' });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Error adding businesses.' });
        }
    }
}